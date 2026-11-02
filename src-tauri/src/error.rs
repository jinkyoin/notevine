use serde::Serialize;

/// Errors returned to the frontend. Serialized as `{ code, message }` so the UI
/// can branch on `code` and show `message` in a toast.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("노트 폴더가 열려 있지 않습니다")]
    NoVault,
    #[error("폴더를 찾을 수 없습니다: {0}")]
    NotADirectory(String),
    #[error("파일이나 폴더를 찾을 수 없습니다: {0}")]
    NotFound(String),
    #[error("같은 이름이 이미 있습니다: {0}")]
    AlreadyExists(String),
    #[error("사용할 수 없는 이름입니다: {0}")]
    InvalidName(String),
    #[error("노트 폴더 밖의 경로는 사용할 수 없습니다: {0}")]
    OutsideVault(String),
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("휴지통으로 옮기지 못했습니다: {0}")]
    Trash(String),
    #[error("{0}")]
    Json(#[from] serde_json::Error),
    #[error("히스토리 저장소 오류: {0}")]
    Db(#[from] rusqlite::Error),
    /// The OS or a library refused (tray, start-up entry, network...).
    #[error("{0}")]
    System(String),
}

impl AppError {
    pub fn code(&self) -> &'static str {
        match self {
            AppError::NoVault => "no_vault",
            AppError::NotADirectory(_) => "not_a_directory",
            AppError::NotFound(_) => "not_found",
            AppError::AlreadyExists(_) => "already_exists",
            AppError::InvalidName(_) => "invalid_name",
            AppError::OutsideVault(_) => "outside_vault",
            AppError::Io(_) => "io",
            AppError::Trash(_) => "trash",
            AppError::Json(_) => "json",
            AppError::Db(_) => "db",
            AppError::System(_) => "system",
        }
    }
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut st = s.serialize_struct("AppError", 2)?;
        st.serialize_field("code", self.code())?;
        st.serialize_field("message", &self.to_string())?;
        st.end()
    }
}

pub type AppResult<T> = Result<T, AppError>;
