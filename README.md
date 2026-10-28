# Notevine

내 컴퓨터의 마크다운 폴더에 업무 기록·아이디어·조사 자료를 쓰고, 링크로 연결하고, 검색과 히스토리로 다시 찾는 데스크톱 앱입니다.

- 노트는 표준 `.md` 파일로만 저장합니다. 다른 편집기로 열어도 그대로입니다.
- 외부 서버로 아무것도 보내지 않습니다.
- MIT 라이선스 오픈소스입니다.

> v0.1 개발 중입니다. v0.1은 **Windows 10 이상**만 지원합니다. macOS·Linux는 v0.2 이후 계획입니다.

## 설치

[Releases](../../releases)에서 `.msi` 또는 `-setup.exe`를 받아 실행합니다.

코드 서명이 없어서 Windows SmartScreen 경고가 뜰 수 있습니다. **추가 정보 → 실행**을 누르면 설치됩니다.

## 개발

필요한 것: Windows 11, [Rust](https://rustup.rs), Node.js 22 이상, Visual Studio Build Tools(C++ 데스크톱 개발), WebView2(Windows 11 기본 포함)

```bash
npm install
npm run tauri dev      # 개발 실행
npm test               # 프론트엔드 테스트 (Vitest)
cargo test --manifest-path src-tauri/Cargo.toml   # 백엔드 테스트
npm run tauri build    # 설치 파일 만들기
```

설계 문서는 [`docs/`](docs)에 있습니다: 개발계획서, 요구사항정의서, 화면설계서.

## 볼트 구조

```
내 볼트/
├─ *.md            # 노트 (유일한 원본)
├─ 첨부/            # 이미지·파일
└─ .app/           # 앱 데이터 (설정, 검색 인덱스, 히스토리)
```

`.app/history.db`에는 노트의 이전 버전이 들어 있고 다시 만들 수 없으므로 백업 대상에 포함하세요.

## 라이선스

MIT
