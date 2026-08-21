//! Handler WASM (Tier 2) del módulo `tasks` — crear tarea, cambiar estado y completar.
//! Portado de old_modules/m_tasks (TaskService.create_task / update_status /
//! complete_task + generate_task_number). Lógica pura, sin BD: cada función recibe
//! `{payload, context}`, valida/normaliza y devuelve **intenciones** (commands
//! `_`-prefijados del propio módulo) que el host valida y ejecuta en UNA transacción,
//! más los eventos `tasks.*` a emitir.
//!
//! Restricciones del runtime actual (sin lecturas pre-cargadas — patrón `kitchen`):
//! * las guardas que dependen del estado PREVIO de la fila van EN EL SQL de la
//!   intención (no-op si no se cumplen): FKs propias de `create_task`
//!   (project/parent vivos), sellado condicional de `completed_at` en
//!   `update_status` (CASE sobre la fila vieja) y `already_done`/`cancelled_locked`
//!   en `complete_task` (`status NOT IN ('done','cancelled')` en el WHERE);
//! * ids: el host pasa `context.new_ids` (autoridad de ids); el guest solo los reparte;
//! * `task_number` atómico `TSK-YYYYMMDD-NNNN`: `_bump_counter` (upsert) +
//!   `_insert_task` leyendo el contador con subquery en la misma transacción
//!   (patrón `sales`/`kitchen`; el guest nunca hace read-back).

use erplora_guest_sdk::{DomainError, Event, Operation, Output};
use serde_json::{json, Map, Value};

#[cfg(feature = "guest")]
use extism_pdk::*;

// ── Exports WASM ───────────────────────────────────────────────────────────

#[cfg(feature = "guest")]
#[plugin_fn]
pub fn create_task(input: Json<erplora_guest_sdk::Input>) -> FnResult<Json<Output>> {
    to_fn_result(create_task_pure(input.into_inner().into_value()))
}

#[cfg(feature = "guest")]
#[plugin_fn]
pub fn update_status(input: Json<erplora_guest_sdk::Input>) -> FnResult<Json<Output>> {
    to_fn_result(update_status_pure(input.into_inner().into_value()))
}

#[cfg(feature = "guest")]
#[plugin_fn]
pub fn complete_task(input: Json<erplora_guest_sdk::Input>) -> FnResult<Json<Output>> {
    to_fn_result(complete_task_pure(input.into_inner().into_value()))
}

#[cfg(feature = "guest")]
fn to_fn_result(r: Result<Output, String>) -> FnResult<Json<Output>> {
    match r {
        Ok(out) => Ok(Json(out)),
        Err(e) => Err(Error::msg(e).into()),
    }
}

// ── Helpers (mismo estilo que sales/kitchen-handler) ───────────────────────

fn as_str(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        _ => String::new(),
    }
}

fn str_or(p: &Value, k: &str, d: &str) -> String {
    let s = as_str(p.get(k).unwrap_or(&Value::Null));
    if s.is_empty() {
        d.to_string()
    } else {
        s
    }
}

/// String opcional: '' o ausente → NULL (refs laxas project_id/parent_task_id/…).
fn opt_str(p: &Value, k: &str) -> Value {
    let s = as_str(p.get(k).unwrap_or(&Value::Null));
    if s.is_empty() {
        Value::Null
    } else {
        Value::String(s)
    }
}

fn day_from_now(now: &str) -> String {
    let date = now.split('T').next().unwrap_or("");
    let digits: String = date.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.len() >= 8 {
        digits[..8].to_string()
    } else {
        "00000000".to_string()
    }
}

struct Ctx {
    now: String,
    user_id: String,
    new_ids: Vec<String>,
}

fn split_input(input: &Value) -> (Value, Ctx) {
    let payload = input.get("payload").cloned().unwrap_or(Value::Null);
    let context = input.get("context").cloned().unwrap_or(Value::Null);
    let empty: Vec<Value> = Vec::new();
    let new_ids = context
        .get("new_ids")
        .and_then(|v| v.as_array())
        .unwrap_or(&empty)
        .iter()
        .map(as_str)
        .collect();
    let ctx = Ctx {
        now: context.get("now").map(as_str).unwrap_or_default(),
        user_id: context
            .get("current_user_id")
            .map(as_str)
            .unwrap_or_default(),
        new_ids,
    };
    (payload, ctx)
}

const PRIORITIES: [&str; 4] = ["low", "medium", "high", "urgent"];
const STATUSES: [&str; 5] = ["todo", "in_progress", "blocked", "done", "cancelled"];

// ── Normalización de due_date (legacy _parse_iso_datetime) ─────────────────

/// Días desde la época civil 1970-01-01 (algoritmo de Howard Hinnant).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// Inversa de [`days_from_civil`].
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = (if z >= 0 { z } else { z - 146096 }) / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

fn days_in_month(y: i64, m: i64) -> i64 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if is_leap(y) {
                29
            } else {
                28
            }
        }
        _ => 0,
    }
}

fn parse_int(s: &str) -> Option<i64> {
    if s.is_empty() || !s.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    s.parse::<i64>().ok()
}

/// Parsea `YYYY-MM-DD` validando rangos del calendario.
fn parse_date(s: &str) -> Option<(i64, i64, i64)> {
    let parts: Vec<&str> = s.split('-').collect();
    if parts.len() != 3 || parts[0].len() != 4 || parts[1].len() != 2 || parts[2].len() != 2 {
        return None;
    }
    let (y, m, d) = (
        parse_int(parts[0])?,
        parse_int(parts[1])?,
        parse_int(parts[2])?,
    );
    if !(1..=12).contains(&m) || d < 1 || d > days_in_month(y, m) {
        return None;
    }
    Some((y, m, d))
}

/// Parsea `HH:MM[:SS[.ffff]]` → segundos del día.
fn parse_time(s: &str) -> Option<i64> {
    let s = s.split('.').next().unwrap_or(s); // descarta fracción de segundo
    let parts: Vec<&str> = s.split(':').collect();
    if parts.len() < 2 || parts.len() > 3 {
        return None;
    }
    let h = parse_int(parts[0])?;
    let mi = parse_int(parts[1])?;
    let se = if parts.len() == 3 {
        parse_int(parts[2])?
    } else {
        0
    };
    if h > 23 || mi > 59 || se > 59 {
        return None;
    }
    Some(h * 3600 + mi * 60 + se)
}

/// Parsea el sufijo de offset (`Z` | `±HH:MM` | `±HHMM` | `±HH`) → (resto, minutos).
fn split_offset(t: &str) -> Option<(&str, i64)> {
    if let Some(rest) = t.strip_suffix('Z').or_else(|| t.strip_suffix('z')) {
        return Some((rest, 0));
    }
    // El signo de offset nunca puede estar en posición 0 (ahí va la hora).
    if let Some(idx) = t.rfind(['+', '-']) {
        if idx > 0 {
            let (rest, off) = t.split_at(idx);
            let sign = if off.starts_with('-') { -1 } else { 1 };
            let off = &off[1..];
            let (h, m) = match off.len() {
                5 if off.as_bytes()[2] == b':' => (parse_int(&off[..2])?, parse_int(&off[3..])?),
                4 => (parse_int(&off[..2])?, parse_int(&off[2..])?),
                2 => (parse_int(off)?, 0),
                _ => return None,
            };
            if h > 23 || m > 59 {
                return None;
            }
            return Some((rest, sign * (h * 60 + m)));
        }
    }
    Some((t, 0)) // naive → se asume UTC (legacy)
}

/// Normaliza `due_date` a ISO UTC `YYYY-MM-DDTHH:MM:SS+00:00`.
/// Acepta `YYYY-MM-DD` (→ medianoche UTC) o datetime ISO con offset `Z`/`±HH:MM`
/// (→ convertido a UTC) o naive (→ se asume UTC). Vacío/null → NULL.
fn normalize_due_date(raw: &Value) -> Result<Value, String> {
    let s = as_str(raw);
    let s = s.trim();
    if s.is_empty() {
        return Ok(Value::Null);
    }
    let (date_part, time_part) = match s.find(['T', ' ']) {
        Some(i) => (&s[..i], &s[i + 1..]),
        None => (s, ""),
    };
    let (y, m, d) = parse_date(date_part).ok_or_else(|| format!("invalid_due_date: {s}"))?;
    if time_part.is_empty() {
        return Ok(json!(format!("{y:04}-{m:02}-{d:02}T00:00:00+00:00")));
    }
    let (clock, off_min) =
        split_offset(time_part).ok_or_else(|| format!("invalid_due_date: {s}"))?;
    let secs = parse_time(clock).ok_or_else(|| format!("invalid_due_date: {s}"))?;

    // A UTC: resta el offset; el desbordamiento de día se resuelve en días civiles.
    let mut total = secs - off_min * 60;
    let mut days = days_from_civil(y, m, d);
    while total < 0 {
        total += 86_400;
        days -= 1;
    }
    while total >= 86_400 {
        total -= 86_400;
        days += 1;
    }
    let (yy, mm, dd) = civil_from_days(days);
    let (hh, rem) = (total / 3600, total % 3600);
    let (mi, ss) = (rem / 60, rem % 60);
    Ok(json!(format!(
        "{yy:04}-{mm:02}-{dd:02}T{hh:02}:{mi:02}:{ss:02}+00:00"
    )))
}

// ── create_task (command tasks.tasks.create) ───────────────────────────────

pub fn create_task_pure(input: Value) -> Result<Output, String> {
    let (payload, ctx) = split_input(&input);

    let title = as_str(payload.get("title").unwrap_or(&Value::Null))
        .trim()
        .to_string();
    if title.is_empty() {
        return Err("missing_title".to_string());
    }
    let priority = str_or(&payload, "priority", "medium");
    if !PRIORITIES.contains(&priority.as_str()) {
        return Err(format!("invalid_priority: {priority}"));
    }
    let due_date = normalize_due_date(payload.get("due_date").unwrap_or(&Value::Null))?;

    let task_id = ctx.new_ids.first().cloned().unwrap_or_default();
    if task_id.is_empty() {
        return Err("missing_new_ids".to_string());
    }
    let day = day_from_now(&ctx.now);

    // tags: lista JSON de strings → columna TEXT JSON ('[]' por defecto).
    let tags: Vec<String> = payload
        .get("tags")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().map(as_str).filter(|s| !s.is_empty()).collect())
        .unwrap_or_default();
    let tags_json = serde_json::to_string(&tags).map_err(|e| format!("invalid_tags: {e}"))?;

    // created_by_ref: payload explícito o el usuario actual (ref laxa a LocalUser).
    let created_by_ref = match opt_str(&payload, "created_by_ref") {
        Value::Null if !ctx.user_id.is_empty() => json!(ctx.user_id),
        v => v,
    };

    let project_id = opt_str(&payload, "project_id");
    let parent_task_id = opt_str(&payload, "parent_task_id");
    let assigned_to_ref = opt_str(&payload, "assigned_to_ref");

    let mut ops: Vec<Operation> = Vec::new();
    let mut bump = Map::new();
    bump.insert("day".into(), json!(day));
    ops.push(Operation::sql("tasks._bump_counter", bump));

    // Las guardas project_not_found / parent_not_found viven en el WHERE del
    // INSERT…SELECT de la intención (no-op si la FK propia no existe viva).
    let mut t = Map::new();
    t.insert("task_id".into(), json!(task_id));
    t.insert("day".into(), json!(day));
    t.insert("title".into(), json!(title));
    t.insert(
        "description".into(),
        json!(str_or(&payload, "description", "")),
    );
    t.insert("project_id".into(), project_id.clone());
    t.insert("priority".into(), json!(priority));
    t.insert("assigned_to_ref".into(), assigned_to_ref.clone());
    t.insert("created_by_ref".into(), created_by_ref);
    t.insert("due_date".into(), due_date.clone());
    t.insert("parent_task_id".into(), parent_task_id.clone());
    t.insert("tags".into(), json!(tags_json));
    ops.push(Operation::sql("tasks._insert_task", t));

    let ev = Event::new(
        "tasks.task.created",
        json!({
            "sender": "tasks",
            "task_id": task_id,
            "title": title,
            "status": "todo",
            "priority": priority,
            "project_id": project_id,
            "parent_task_id": parent_task_id,
            "assigned_to_ref": assigned_to_ref,
            "due_date": due_date,
        }),
    );

    Ok(Output {
        operations: ops,
        events: vec![ev],
        ..Default::default()
    })
}

// ── La guarda de existencia: la lectura pre-cargada, no el WHERE del SQL ───
//
// tasks#22 cerró este mismo agujero en `assign`/`add_comment`, que son SQL puro: allí basta
// `expect_rows` en el manifest. En un command Tier-2 NO sirve, y no es un olvido: el gate del
// runtime cuenta las filas sobre las primeras `cmd.sql.len()` operaciones
// (`crates/runtime/src/commands.rs`), y en Tier-2 ese bloque está VACÍO —la lógica va por el
// handler— así que las intenciones que devuelve el WASM entran como `extra_ops`, que el gate no
// cuenta. Declarar `expect_rows` aquí no protegería: contaría 0 filas SIEMPRE y rechazaría también
// el camino feliz.
//
// Así que la guarda va donde sí hay contexto: en el handler, sobre la lectura que el runtime
// pre-carga (`reads`, ADR-0069). El manifest declara
// `{"query": "tasks.tasks.get", "params": {"task_id": "payload.task_id"}, "required": true}` y el
// handler decide ANTES de construir el evento. Es lo mismo que hace `appointments` con la agenda:
// una guarda que degrada cuando la lectura no llega no es una guarda.

/// Filas de una lectura pre-cargada. `None` = la read no llegó (≠ llegó vacía, que es «no existe»).
fn read_rows<'a>(input: &'a Value, query: &str) -> Option<&'a Vec<Value>> {
    input
        .get("context")?
        .get("reads")?
        .get(query)?
        .as_array()
}

/// La tarea que el command dice tocar, tal y como la ve el SERVIDOR.
///
/// Tres respuestas, y las tres importan:
/// * `Ok(row)`      — existe en ESTE hub y no está borrada (el `WHERE` de `tasks.tasks.get` ya lo
///                    acota, y el runtime inyecta el `hub_id`: no es negociable desde el payload);
/// * `Err(not_found)` — la read llegó VACÍA: inexistente, de otro hub o borrada. Es el caso que
///                    hacía un UPDATE de 0 filas y emitía el evento igual;
/// * `Err(unreadable)` — la read NO llegó. Sin ella no se sabe si la fila existe, y adivinar es
///                    exactamente lo que esta issue viene a quitar.
fn resolve_task(input: &Value) -> Result<&Value, DomainError> {
    match read_rows(input, "tasks.tasks.get") {
        None => Err(DomainError::new(
            "tasks.task_unreadable",
            "That task could not be read, so nothing was changed. Try again.",
        )),
        Some(rows) => rows.first().ok_or_else(|| {
            DomainError::new(
                "tasks.task_not_found",
                "That task does not exist in this business.",
            )
        }),
    }
}

// ── update_status (command tasks.tasks.update_status) ──────────────────────

pub fn update_status_pure(input: Value) -> Result<Output, String> {
    let (payload, ctx) = split_input(&input);
    let input = &input;
    let task_id = as_str(payload.get("task_id").unwrap_or(&Value::Null));
    if task_id.is_empty() {
        return Err("missing_task_id".to_string());
    }
    let new_status = as_str(payload.get("new_status").unwrap_or(&Value::Null));
    if !STATUSES.contains(&new_status.as_str()) {
        return Err(format!("invalid_status: {new_status}"));
    }

    // La tarea tiene que existir ANTES de construir el evento (tasks#26): hasta aquí el UPDATE
    // podía tocar 0 filas y `tasks.task.status_changed` se publicaba igual, así que quien lo
    // escuchaba reaccionaba a un cambio que nunca ocurrió.
    if let Err(e) = resolve_task(input) {
        return Ok(Output::new().with_error(e));
    }

    // El sellado condicional de completed_at depende del estado PREVIO: lo resuelve
    // el CASE del SQL sobre la fila vieja (done→:now; reapertura desde done→NULL).
    let mut p = Map::new();
    p.insert("task_id".into(), json!(task_id));
    p.insert("new_status".into(), json!(new_status));

    let ev = Event::new(
        "tasks.task.status_changed",
        json!({
            "sender": "tasks",
            "task_id": task_id,
            "new_status": new_status,
            "changed_by": if ctx.user_id.is_empty() { Value::Null } else { json!(ctx.user_id) },
        }),
    );

    Ok(Output {
        operations: vec![Operation::sql("tasks._set_status", p)],
        events: vec![ev],
        ..Default::default()
    })
}

// ── complete_task (command tasks.tasks.complete) ───────────────────────────

pub fn complete_task_pure(input: Value) -> Result<Output, String> {
    let (payload, ctx) = split_input(&input);
    let task_id = as_str(payload.get("task_id").unwrap_or(&Value::Null));
    if task_id.is_empty() {
        return Err("missing_task_id".to_string());
    }

    // La tarea tiene que existir y estar ABIERTA (tasks#26). El `WHERE … status NOT IN
    // ('done','cancelled')` de la intención ya hacía no-op estos dos casos, pero un no-op sigue
    // siendo 0 filas con `tasks.task.completed` publicado: quien lo escuchaba daba por cerrada una
    // tarea que nadie cerró, o la cerraba dos veces. Se rechaza aquí, y con códigos distintos: «ya
    // estaba cerrada» y «no existe» no se arreglan igual.
    let task = match resolve_task(&input) {
        Ok(row) => row,
        Err(e) => return Ok(Output::new().with_error(e)),
    };
    let status = as_str(task.get("status").unwrap_or(&Value::Null));
    if status == "done" || status == "cancelled" {
        return Ok(Output::new().with_error(DomainError::new(
            "tasks.task_already_closed",
            "That task is already closed, so it was left as it was.",
        )));
    }

    let mut p = Map::new();
    p.insert("task_id".into(), json!(task_id));

    let ev = Event::new(
        "tasks.task.completed",
        json!({
            "sender": "tasks",
            "task_id": task_id,
            "completed_by": if ctx.user_id.is_empty() { Value::Null } else { json!(ctx.user_id) },
            "completed_at": ctx.now,
        }),
    );

    Ok(Output {
        operations: vec![Operation::sql("tasks._complete", p)],
        events: vec![ev],
        ..Default::default()
    })
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// El input tal y como lo arma el host: payload + contexto con las reads pre-cargadas.
    fn input_with_read(payload: Value, rows: Option<Value>) -> Value {
        let mut context = Map::new();
        context.insert("now".into(), json!("2026-08-20T10:00:00Z"));
        context.insert("current_user_id".into(), json!("u-1"));
        context.insert("new_ids".into(), json!([]));
        if let Some(rows) = rows {
            context.insert("reads".into(), json!({ "tasks.tasks.get": rows }));
        }
        json!({ "payload": payload, "context": Value::Object(context) })
    }

    fn live_task(status: &str) -> Value {
        json!([{ "id": "t-1", "task_number": "TSK-20260820-0001", "title": "Reponer barril",
                 "status": status, "priority": "medium", "is_deleted": 0 }])
    }

    // ── update_status ──────────────────────────────────────────────────────

    #[test]
    fn update_status_emits_when_the_task_is_there() {
        let out = update_status_pure(input_with_read(
            json!({ "task_id": "t-1", "new_status": "in_progress" }),
            Some(live_task("todo")),
        ))
        .expect("el camino feliz no puede fallar");
        assert!(out.error.is_none(), "el camino feliz no rechaza");
        assert_eq!(out.operations.len(), 1, "una intención: el UPDATE");
        assert_eq!(out.events.len(), 1, "y su evento");
        assert_eq!(out.events[0].name, "tasks.task.status_changed");
    }

    /// El fallo de la issue: la tarea no existe (o es de otro hub, o está borrada) y la lectura
    /// vuelve vacía. El UPDATE afectaría 0 filas y el evento se publicaba igual.
    #[test]
    fn update_status_refuses_when_the_task_is_not_there() {
        // Vacío es lo que devuelve el host cuando la query no casa ninguna fila: inexistente, de
        // otro hub o borrada (`tasks.tasks.get` filtra por `hub_id` y por `is_deleted`, y el
        // `hub_id` lo inyecta el runtime, no el payload).
        let out = update_status_pure(input_with_read(
            json!({ "task_id": "fantasma", "new_status": "done" }),
            Some(json!([])),
        ))
        .expect("un rechazo de negocio es una respuesta, no un panic");
        let err = out.error.expect("tenía que rechazar");
        assert_eq!(err.code, "tasks.task_not_found", "código estable para el caller");
        assert!(out.operations.is_empty(), "no se escribe nada");
        assert!(out.events.is_empty(), "y sobre todo: NO se emite el evento");
    }

    /// Sin la read no hay forma de saber si la fila existe: se rechaza, no se adivina. Es la
    /// misma regla que `appointments` (ADR-0069 §1): una guarda que degrada no es una guarda.
    #[test]
    fn update_status_refuses_when_the_read_did_not_arrive() {
        let out = update_status_pure(input_with_read(
            json!({ "task_id": "t-1", "new_status": "done" }),
            None,
        ))
        .expect("un rechazo de negocio es una respuesta");
        assert_eq!(out.error.expect("tenía que rechazar").code, "tasks.task_unreadable");
        assert!(out.events.is_empty(), "NO se emite el evento a ciegas");
    }

    #[test]
    fn update_status_still_rejects_a_status_that_does_not_exist() {
        let err = update_status_pure(input_with_read(
            json!({ "task_id": "t-1", "new_status": "inventado" }),
            Some(live_task("todo")),
        ))
        .unwrap_err();
        assert!(err.contains("invalid_status"), "la validación de siempre sigue: {err}");
    }

    // ── complete ───────────────────────────────────────────────────────────

    #[test]
    fn complete_emits_when_the_task_is_open() {
        let out = complete_task_pure(input_with_read(
            json!({ "task_id": "t-1" }),
            Some(live_task("in_progress")),
        ))
        .expect("el camino feliz no puede fallar");
        assert!(out.error.is_none());
        assert_eq!(out.operations.len(), 1);
        assert_eq!(out.events.len(), 1);
        assert_eq!(out.events[0].name, "tasks.task.completed");
    }

    #[test]
    fn complete_refuses_when_the_task_is_not_there() {
        let out = complete_task_pure(input_with_read(json!({ "task_id": "fantasma" }), Some(json!([]))))
            .expect("un rechazo de negocio es una respuesta");
        let err = out.error.expect("tenía que rechazar");
        assert_eq!(err.code, "tasks.task_not_found");
        assert!(out.operations.is_empty());
        assert!(out.events.is_empty(), "NO se emite `tasks.task.completed`");
    }

    /// El `WHERE … status NOT IN ('done','cancelled')` del SQL ya hacía no-op estos dos casos: 0
    /// filas y, aun así, evento. Ahora se rechazan antes, con un código que distingue «ya estaba
    /// cerrada» de «no existe» — el usuario no busca lo mismo en uno y en otro.
    #[test]
    fn complete_refuses_a_task_that_is_already_closed() {
        for status in ["done", "cancelled"] {
            let out = complete_task_pure(input_with_read(
                json!({ "task_id": "t-1" }),
                Some(live_task(status)),
            ))
            .expect("un rechazo de negocio es una respuesta");
            let err = out.error.unwrap_or_else(|| panic!("{status} tenía que rechazar"));
            assert_eq!(err.code, "tasks.task_already_closed", "estado {status}");
            assert!(out.operations.is_empty(), "estado {status}: no se escribe");
            assert!(out.events.is_empty(), "estado {status}: NO se emite el evento");
        }
    }

    #[test]
    fn complete_refuses_when_the_read_did_not_arrive() {
        let out = complete_task_pure(input_with_read(json!({ "task_id": "t-1" }), None))
            .expect("un rechazo de negocio es una respuesta");
        assert_eq!(out.error.expect("tenía que rechazar").code, "tasks.task_unreadable");
        assert!(out.events.is_empty());
    }
}
