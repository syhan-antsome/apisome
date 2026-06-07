# B2C API Workbench

Tauri 2 + React + TypeScript 기반의 로컬 API 테스트 도구입니다. 서버/API/토큰 정보를 로컬에 저장하고, 선택한 API를 Bearer 토큰과 함께 실행할 수 있습니다.

## 주요 기능

- 서버 프로필 등록
- API 요청 템플릿 등록
- Path parameter 지원: `/api/users/{memberId}`
- Bearer 토큰 저장 및 API 호출 시 자동 헤더 적용
- 요청 전문과 응답 본문 확인
- macOS / Windows 데스크톱 앱 빌드

## Windows 빌드 준비

Windows 노트북에서 처음 빌드할 때는 아래 도구가 필요합니다.

- Git
- Node.js LTS
- Rust
- Microsoft C++ Build Tools
- Microsoft Edge WebView2 Runtime

Tauri 공식 Windows 준비 문서:

- https://v2.tauri.app/start/prerequisites/

### 1. Git 설치

Git이 없다면 설치합니다.

- https://git-scm.com/download/win

설치 후 PowerShell 또는 Windows Terminal에서 확인합니다.

```powershell
git --version
```

### 2. Node.js LTS 설치

Node.js LTS 버전을 설치합니다.

- https://nodejs.org/

설치 후 확인합니다.

```powershell
node -v
npm -v
```

### 3. Rust 설치

Rust는 `rustup`으로 설치합니다.

- https://www.rust-lang.org/tools/install

Windows에서는 MSVC toolchain을 사용해야 합니다. 설치 후 새 터미널을 열고 확인합니다.

```powershell
rustc -V
cargo -V
rustup default
```

`stable-x86_64-pc-windows-msvc` 계열이면 정상입니다.

### 4. Microsoft C++ Build Tools 설치

Visual Studio Build Tools를 설치합니다.

- https://visualstudio.microsoft.com/visual-cpp-build-tools/

설치 화면에서 아래 workload를 선택합니다.

- Desktop development with C++

함께 포함되어야 하는 항목:

- MSVC C++ build tools
- Windows SDK

설치 후 터미널을 새로 열어 빌드하세요.

### 5. Microsoft Edge WebView2 Runtime

Windows 11에는 보통 포함되어 있습니다. 실행 시 WebView2 관련 오류가 나면 Evergreen Runtime을 설치합니다.

- https://developer.microsoft.com/en-us/microsoft-edge/webview2/

## 클론 및 설치

```powershell
git clone git@github.com:syhan-antsome/apisome.git
cd apisome
npm install
```

SSH 키가 설정되어 있지 않다면 HTTPS 주소로 클론해도 됩니다.

```powershell
git clone https://github.com/syhan-antsome/apisome.git
cd apisome
npm install
```

## 개발 실행

개발 모드로 데스크톱 앱을 실행합니다.

```powershell
npm run desktop
```

프론트엔드만 브라우저에서 확인하려면 아래 명령을 사용할 수 있습니다.

```powershell
npm run dev
```

## 빌드

프론트엔드 타입 검사와 웹 빌드만 실행합니다.

```powershell
npm run build
```

설치파일 없이 현재 플랫폼용 실행 파일만 빌드합니다.

```powershell
npm run build:exe
```

Windows에서는 아래 파일이 생성됩니다.

```text
src-tauri\target\release\b2c-api-workbench.exe
```

이 파일은 설치 과정 없이 직접 실행할 수 있습니다. 다만 받는 PC에 Microsoft Edge WebView2 Runtime이 필요할 수 있습니다.

macOS에서는 같은 명령이 `.app`이 아니라 실행 바이너리만 만듭니다. macOS 사용자에게 전달할 앱 번들이 필요하면 아래 명령을 사용합니다.

```powershell
npm run build:app
```

Windows 설치 파일까지 만들려면 아래 명령을 사용합니다.

```powershell
npm run build:installer
```

빌드 결과는 보통 아래 폴더에 생성됩니다.

```text
src-tauri\target\release\
src-tauri\target\release\bundle\
```

Windows에서 확인할 주요 결과물:

- 직접 실행 파일: `src-tauri\target\release\b2c-api-workbench.exe`
- 설치 파일: `src-tauri\target\release\bundle\...`

설치 파일의 정확한 하위 폴더명은 Windows 번들러 설정과 Tauri 버전에 따라 달라질 수 있습니다. `bundle` 폴더 아래의 `.exe` 또는 `.msi` 파일을 확인하세요.

## 자주 생기는 문제

### `EBUSY: resource busy or locked, watch ...\src-tauri\target...dll` 오류

Windows에서 `npm run desktop` 실행 중 Rust 빌드 산출물 DLL을 Vite가 감시하려고 할 때 발생할 수 있습니다. `vite.config.ts`에서 `src-tauri/target`과 `src-tauri/gen` 폴더를 watch 제외하도록 설정되어 있어야 합니다.

이미 오류가 난 터미널은 종료한 뒤 다시 실행하세요. 필요하면 아래 산출물을 삭제하고 재시도할 수 있습니다.

```powershell
Remove-Item -Recurse -Force .\src-tauri\target
npm run desktop
```

### `link.exe` 또는 C++ build tools 관련 오류

Microsoft C++ Build Tools가 설치되지 않았거나, Windows SDK가 빠진 경우입니다.

해결:

- Visual Studio Build Tools 설치
- `Desktop development with C++` workload 선택
- 터미널을 새로 열고 다시 빌드

### Rust toolchain 오류

Windows GNU toolchain이 잡혀 있으면 Tauri 빌드가 꼬일 수 있습니다. MSVC toolchain을 기본값으로 설정합니다.

```powershell
rustup default stable-x86_64-pc-windows-msvc
```

### WebView2 오류

Microsoft Edge WebView2 Runtime을 설치합니다.

## 개발 메모

- 앱 설정 데이터는 로컬 SQLite에 저장됩니다.
- 토큰 값은 OS 보안 저장소를 우선 사용하고, 실패 시 앱 로컬 fallback 저장소를 사용합니다.
- 빌드 산출물(`dist`, `target`, `node_modules`)은 Git에 올리지 않습니다.
