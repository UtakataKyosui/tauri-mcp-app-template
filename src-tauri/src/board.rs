use serde::{de::Error as _, Deserialize, Deserializer, Serialize};
use specta::Type;
use std::{
    collections::BTreeMap,
    fs, io,
    path::PathBuf,
    sync::{Arc, Mutex},
};

#[derive(Debug, Clone, Serialize, Deserialize, Type, rmcp::schemars::JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Runtime {
    Claude,
    Codex,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, rmcp::schemars::JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Backlog,
    Ready,
    Doing,
    Review,
    Done,
    Blocked,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, rmcp::schemars::JsonSchema, PartialEq, Eq)]
#[serde(untagged)]
pub enum Effort {
    Named(String),
    Budget(u32),
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Assignment {
    pub runtime: Runtime,
    pub model: String,
    pub effort: Effort,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProgressEntry {
    pub at: String,
    pub by: String,
    pub note: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, Type, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AccessRule {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allow: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deny: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, Type, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Policy {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skills: Option<AccessRule>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agents: Option<AccessRule>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Card {
    pub id: String,
    pub title: String,
    pub objective: String,
    pub requirements: Vec<String>,
    pub status: Status,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
    pub assignment: Assignment,
    pub summary: String,
    pub entries: Vec<ProgressEntry>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, Type, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Board {
    pub cards: Vec<Card>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub focus: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub policies: Option<BTreeMap<String, Policy>>,
}

#[derive(Debug, Clone, Deserialize, Type, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateCard {
    pub id: String,
    pub title: String,
    pub objective: String,
    pub requirements: Vec<String>,
    pub status: Status,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
    pub assignment: Assignment,
    pub summary: String,
}

#[derive(Debug, Clone, Default, Deserialize, Type, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PatchCard {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "non_null"
    )]
    #[specta(type = String)]
    #[schemars(with = "String")]
    pub title: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "non_null"
    )]
    #[specta(type = String)]
    #[schemars(with = "String")]
    pub objective: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "non_null"
    )]
    #[specta(type = Vec<String>)]
    #[schemars(with = "Vec<String>")]
    pub requirements: Option<Vec<String>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "non_null"
    )]
    #[specta(type = Status)]
    #[schemars(with = "Status")]
    pub status: Option<Status>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nullable"
    )]
    pub phase: Option<Option<String>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "non_null"
    )]
    #[specta(type = Assignment)]
    #[schemars(with = "Assignment")]
    pub assignment: Option<Assignment>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "non_null"
    )]
    #[specta(type = String)]
    #[schemars(with = "String")]
    pub summary: Option<String>,
}

fn non_null<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)?
        .map(Some)
        .ok_or_else(|| D::Error::custom("null is not allowed"))
}

fn nullable<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, Deserialize, Type, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AddProgress {
    pub entry: ProgressEntry,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Type, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PatchBoard {
    #[serde(default, deserialize_with = "nullable")]
    pub focus: Option<Option<String>>,
    #[serde(default, deserialize_with = "nullable")]
    pub policies: Option<Option<BTreeMap<String, Policy>>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Correlation {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub card_id: Option<String>,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_id: Option<String>,
    pub at: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_creation: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ToolUse {
    pub tool: String,
    pub at: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SkillUse {
    pub skill: String,
    pub at: f64,
    pub via: SkillVia,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum SkillVia {
    Tool,
    Expansion,
    Blocked,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentSpawnRecord {
    pub tool_use_id: String,
    pub subagent_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub background: bool,
    pub at: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentState {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub status: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spawned_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TurnRecord {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub card_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_id: Option<String>,
    pub turn_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    pub reason: String,
    pub duration_ms: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<Effort>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens: Option<TokenUsage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub answer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub answer_length: Option<f64>,
    pub tools: Vec<ToolUse>,
    pub skills: Vec<SkillUse>,
    pub agents: Vec<AgentSpawnRecord>,
    pub agent_states: Vec<AgentState>,
    pub at: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    board: Board,
    #[serde(default)]
    correlations: Vec<Correlation>,
    #[serde(default)]
    turns: Vec<TurnRecord>,
}

impl Default for Snapshot {
    fn default() -> Self {
        Self {
            board: Board::default(),
            correlations: Vec::new(),
            turns: Vec::new(),
        }
    }
}

#[derive(Clone)]
pub struct BoardStore {
    inner: Arc<Mutex<Snapshot>>,
    path: PathBuf,
}

#[derive(Debug)]
pub enum StoreError {
    NotFound,
    Conflict,
    Invalid(String),
    Io(io::Error),
}

impl BoardStore {
    pub fn open(path: PathBuf) -> io::Result<Self> {
        let snapshot = if path.exists() {
            serde_json::from_slice(&fs::read(&path)?)
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?
        } else {
            Snapshot::default()
        };
        Ok(Self {
            inner: Arc::new(Mutex::new(snapshot)),
            path,
        })
    }

    pub fn board(&self) -> Board {
        self.inner.lock().unwrap().board.clone()
    }
    pub fn patch_board(&self, input: PatchBoard) -> Result<Board, StoreError> {
        self.change(|state| {
            if let Some(focus) = input.focus {
                if let Some(ref id) = focus {
                    if !state.board.cards.iter().any(|card| &card.id == id) {
                        return Err(StoreError::NotFound);
                    }
                }
                state.board.focus = focus;
            }
            if let Some(policies) = input.policies {
                state.board.policies = policies;
            }
            Ok(state.board.clone())
        })
    }
    pub fn card(&self, id: &str) -> Result<Card, StoreError> {
        self.board()
            .cards
            .into_iter()
            .find(|card| card.id == id)
            .ok_or(StoreError::NotFound)
    }
    pub fn create(&self, input: CreateCard) -> Result<Card, StoreError> {
        validate_id(&input.id)?;
        let card = Card {
            id: input.id,
            title: input.title,
            objective: input.objective,
            requirements: input.requirements,
            status: input.status,
            phase: input.phase,
            assignment: input.assignment,
            summary: input.summary,
            entries: Vec::new(),
            updated_at: now(),
        };
        validate_card(&card)?;
        self.change(|state| {
            if state
                .board
                .cards
                .iter()
                .any(|current| current.id == card.id)
            {
                return Err(StoreError::Conflict);
            }
            state.board.cards.push(card.clone());
            Ok(card)
        })
    }
    pub fn patch(&self, id: &str, input: PatchCard) -> Result<Card, StoreError> {
        self.change(|state| {
            let card = state
                .board
                .cards
                .iter_mut()
                .find(|card| card.id == id)
                .ok_or(StoreError::NotFound)?;
            if let Some(value) = input.title {
                card.title = value;
            }
            if let Some(value) = input.objective {
                card.objective = value;
            }
            if let Some(value) = input.requirements {
                card.requirements = value;
            }
            if let Some(value) = input.status {
                card.status = value;
            }
            if let Some(value) = input.phase {
                card.phase = value;
            }
            if let Some(value) = input.assignment {
                card.assignment = value;
            }
            if let Some(value) = input.summary {
                card.summary = value;
            }
            validate_card(card)?;
            card.updated_at = now();
            Ok(card.clone())
        })
    }
    pub fn progress(&self, id: &str, input: AddProgress) -> Result<Card, StoreError> {
        if input.entry.note.trim().is_empty() {
            return Err(StoreError::Invalid("note must be nonempty".into()));
        }
        self.change(|state| {
            let card = state
                .board
                .cards
                .iter_mut()
                .find(|card| card.id == id)
                .ok_or(StoreError::NotFound)?;
            if card.entries.contains(&input.entry) {
                return Ok(card.clone());
            }
            card.entries.push(input.entry);
            if let Some(summary) = input.summary {
                card.summary = summary;
            }
            card.updated_at = now();
            Ok(card.clone())
        })
    }
    pub fn delete(&self, id: &str) -> Result<(), StoreError> {
        self.change(|state| {
            let before = state.board.cards.len();
            state.board.cards.retain(|card| card.id != id);
            if state.board.cards.len() == before {
                return Err(StoreError::NotFound);
            }
            if state.board.focus.as_deref() == Some(id) {
                state.board.focus = None;
            }
            Ok(())
        })
    }
    pub fn record_turn(&self, item: TurnRecord) -> Result<(), StoreError> {
        if item.turn_id.trim().is_empty() {
            return Err(StoreError::Invalid("turnId must be nonempty".into()));
        }
        self.change(|state| {
            if !state.turns.iter().any(|old| {
                old.turn_id == item.turn_id
                    && old.session_id == item.session_id
                    && old.agent_id == item.agent_id
            }) {
                state.turns.push(item);
            }
            Ok(())
        })
    }
    pub fn correlate(&self, item: Correlation) -> Result<(), StoreError> {
        self.change(|state| {
            if !state.correlations.iter().any(|old| {
                old.session_id == item.session_id
                    && old.prompt_id == item.prompt_id
                    && old.card_id == item.card_id
            }) {
                state.correlations.push(item);
            }
            Ok(())
        })
    }
    fn change<T>(
        &self,
        update: impl FnOnce(&mut Snapshot) -> Result<T, StoreError>,
    ) -> Result<T, StoreError> {
        let mut current = self.inner.lock().unwrap();
        let mut next = current.clone();
        let result = update(&mut next)?;
        let bytes = serde_json::to_vec_pretty(&next)
            .map_err(|error| StoreError::Invalid(error.to_string()))?;
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(StoreError::Io)?;
        }
        let temp = self.path.with_extension("json.tmp");
        fs::write(&temp, bytes).map_err(StoreError::Io)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&temp, fs::Permissions::from_mode(0o600))
                .map_err(StoreError::Io)?;
        }
        fs::rename(&temp, &self.path).map_err(StoreError::Io)?;
        *current = next;
        let revision = self.path.with_file_name("board.revision");
        let _ = fs::write(revision, now());
        Ok(result)
    }
}

fn validate_id(id: &str) -> Result<(), StoreError> {
    if id.trim().is_empty() {
        return Err(StoreError::Invalid("id must be nonempty".into()));
    }
    Ok(())
}

fn validate_card(card: &Card) -> Result<(), StoreError> {
    if card.title.trim().is_empty() {
        return Err(StoreError::Invalid("title must be nonempty".into()));
    }
    if card.assignment.model.trim().is_empty() {
        return Err(StoreError::Invalid(
            "assignment.model must be nonempty".into(),
        ));
    }
    match &card.assignment.effort {
        Effort::Named(value) if value.trim().is_empty() => Err(StoreError::Invalid(
            "assignment.effort must be nonempty".into(),
        )),
        Effort::Budget(0) => Err(StoreError::Invalid(
            "assignment.effort budget must be positive".into(),
        )),
        _ => Ok(()),
    }
}

fn now() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patch_distinguishes_omitted_and_null() {
        let omitted: PatchCard = serde_json::from_str("{}").unwrap();
        assert!(omitted.phase.is_none());
        let clear: PatchCard = serde_json::from_str(r#"{"phase":null}"#).unwrap();
        assert!(matches!(clear.phase, Some(None)));
        assert!(serde_json::from_str::<PatchCard>(r#"{"title":null}"#).is_err());

        let schema = serde_json::to_value(schemars::schema_for!(PatchCard)).unwrap();
        assert_eq!(
            schema.pointer("/properties/title/type"),
            Some(&serde_json::json!("string"))
        );
    }

    #[test]
    fn patch_rejects_invalid_card_fields() {
        let path = std::env::temp_dir().join(format!("kanban-patch-{}.json", std::process::id()));
        let store = BoardStore::open(path).unwrap();
        store
            .create(CreateCard {
                id: "one".into(),
                title: "One".into(),
                objective: String::new(),
                requirements: vec![],
                status: Status::Ready,
                phase: None,
                assignment: Assignment {
                    runtime: Runtime::Claude,
                    model: "test".into(),
                    effort: Effort::Named("low".into()),
                    role: None,
                },
                summary: String::new(),
            })
            .unwrap();
        assert!(store
            .patch(
                "one",
                PatchCard {
                    title: Some(String::new()),
                    ..PatchCard::default()
                }
            )
            .is_err());
        assert!(store
            .patch(
                "one",
                PatchCard {
                    assignment: Some(Assignment {
                        runtime: Runtime::Claude,
                        model: String::new(),
                        effort: Effort::Named("low".into()),
                        role: None
                    }),
                    ..PatchCard::default()
                }
            )
            .is_err());
        assert_eq!(store.card("one").unwrap().title, "One");
    }

    #[test]
    fn progress_replay_is_saved_once() {
        let path = std::env::temp_dir().join(format!("kanban-replay-{}.json", std::process::id()));
        let store = BoardStore::open(path.clone()).unwrap();
        store
            .create(CreateCard {
                id: "one".into(),
                title: "One".into(),
                objective: String::new(),
                requirements: vec![],
                status: Status::Ready,
                phase: None,
                assignment: Assignment {
                    runtime: Runtime::Claude,
                    model: "test".into(),
                    effort: Effort::Named("low".into()),
                    role: None,
                },
                summary: String::new(),
            })
            .unwrap();
        let progress = AddProgress {
            entry: ProgressEntry {
                at: "2026-09-22T00:00:00Z".into(),
                by: "claude".into(),
                note: "done".into(),
            },
            summary: Some("finished".into()),
        };
        store.progress("one", progress.clone()).unwrap();
        store.progress("one", progress).unwrap();
        assert_eq!(
            BoardStore::open(path)
                .unwrap()
                .card("one")
                .unwrap()
                .entries
                .len(),
            1
        );
    }
}
