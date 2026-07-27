# 텐카 템플릿 에디터

게임 추천 짤방 생성기. 사진·움짤을 얹고 문구를 고쳐 GIF, PNG, 영상으로 저장합니다.

빌드 도구가 필요 없습니다. 파일을 그대로 올리면 GitHub Pages에서 바로 돕니다.

## 올리는 방법

저장소 루트가 이렇게 되면 됩니다.

```
Tenka-ZZANG-Template/
├── index.html
├── styles.css
├── tenka.png        ← 기존 파일 그대로 두세요
├── src/
│   ├── main.js
│   ├── config.js
│   ├── state.js
│   ├── store.js
│   ├── assets.js
│   ├── renderer.js
│   ├── text.js
│   ├── interact.js
│   ├── textedit.js
│   ├── exporter.js
│   ├── ui.js
│   ├── gif/
│   │   ├── encoder.js
│   │   └── decoder.js
│   └── workers/
│       └── gif.worker.js
└── old/
    └── old.html     ← 구버전, 링크가 걸려 있으니 그대로 두세요
```

`tenka.png`가 `index.html` 옆에 없으면 배경 없이 뜨고 상단에 경고가 나옵니다.

ES 모듈을 쓰므로 `file://`로 직접 열면 동작하지 않습니다. 로컬에서 확인하려면
저장소 폴더에서 `python3 -m http.server` 를 띄우고 `http://localhost:8000` 으로 접속하세요.

## 조작

| 하고 싶은 것 | 방법 |
|---|---|
| 사진 넣기 | 빈 칸 클릭 · 끌어다 놓기 · `Ctrl+V` 로 스크린샷 붙여넣기 |
| 위치 옮기기 | 드래그, 또는 방향키(`Shift`+방향키는 10px씩) |
| 크기 | 모서리 핸들 드래그, 휠, 모바일은 두 손가락 |
| 회전 | 위쪽 핸들 드래그 (`Shift` 누르면 15° 단위) |
| 문구 고치기 | 문구를 두 번 클릭, 또는 선택 후 `Enter` |
| 되돌리기 | `Ctrl+Z` / `Ctrl+Shift+Z` |
| 선택 해제 | `Esc` |
| 사진 빼기 | 선택 후 `Delete` |

작업 내용은 자동 저장됩니다. 새로고침하거나 브라우저를 닫아도 다시 열면 이어집니다.

## 구조

```
main.js       조립 — 렌더 루프, 단축키, 붙여넣기, 드래그앤드롭, 자동저장
config.js     템플릿 좌표와 기본값 (칸 위치를 바꾸려면 여기만 고치면 됩니다)
state.js      상태 모델과 히스토리
store.js      IndexedDB 자동 저장
assets.js     사진·움짤 레지스트리, 워커 브리지
renderer.js   drawScene() — 화면과 내보내기가 공유하는 단 하나의 렌더 함수
text.js       줄바꿈, 자동 크기 맞춤
interact.js   포인터 조작과 선택 핸들
textedit.js   캔버스 위 textarea 오버레이 (한글 입력용)
exporter.js   PNG · GIF · 영상 저장
ui.js         인스펙터 패널, 알림, 내보내기 대화상자
gif/          자체 구현 GIF 인코더·디코더
workers/      GIF 처리 워커
```

### 설계에서 신경 쓴 것

**상태에 이미지를 넣지 않습니다.** 상태에는 에셋 ID만 들어가고 실제 픽셀은
`assets.js` 레지스트리에 삽니다. 그래서 되돌리기 스냅샷 하나가 약 0.5KB이고,
200단계를 쌓아도 100KB가 안 됩니다.

**화면과 결과물이 같은 함수를 씁니다.** `drawScene()` 하나를 배율만 바꿔 호출하므로
"미리보기랑 저장한 게 다르다"가 구조적으로 생길 수 없습니다.

**움짤은 불러올 때 전 프레임을 미리 풀어둡니다.** 저장할 때 프레임을 찾는 게
O(1)이 됩니다. 원본은 매번 앞 프레임부터 다시 그려 넘어가는 방식이었습니다.

**GIF 코덱은 직접 구현했습니다.** 외부 CDN에 의존하지 않고, 전역 팔레트와
프레임 차분을 씁니다. 변한 영역만 인코딩하고 안 변한 픽셀은 투명 처리합니다.

**한글 입력은 브라우저에 맡깁니다.** 캔버스에 커서를 직접 그리는 대신 투명한
`<textarea>`를 정확히 겹쳐 놓습니다. 조합 중 글자가 깨지지 않습니다.

## 브라우저

크롬·엣지·사파리·파이어폭스 최신 버전. 영상 저장은 `MediaRecorder` 지원 여부에 따라
WebM 또는 MP4로 나가며, 지원하지 않으면 해당 버튼이 비활성화됩니다.

## 칸 위치를 바꾸려면

`src/config.js` 의 `SLOTS` 와 `TEXTS` 만 고치면 됩니다. 나머지 코드는 이 값을 읽어
씁니다.

```js
export const SLOTS = [
  { key: 'bubble', label: '말풍선', rect: { x: 200, y: 0, w: 700, h: 440 }, above: false },
  ...
];
```

`above: true` 면 템플릿 그림 위에, `false` 면 아래에 그립니다.
