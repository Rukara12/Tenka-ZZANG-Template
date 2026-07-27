# 코드 분석 — 텐카 템플릿 에디터

배포처: https://rukara12.github.io/Tenka-ZZANG-Template/ (정상 동작 확인)
분석 대상: 소스 약 4,500줄 (JS 3,500 / CSS 680 / HTML 260) + 에셋 1.4MB

---

## 1. 전체 평가

빌드 도구 없이 ES 모듈만으로 굴러가는 정적 사이트다. GitHub Pages 배포 형태로는
가장 이상적인 구성이고, 실제로 서브패스(`/Tenka-ZZANG-Template/`) 환경에서
경로가 전부 상대경로라 문제없이 뜬다.

구조적으로 잘 되어 있는 지점 세 가지:

- **상태에 픽셀이 없다.** `state.js`는 에셋 ID만 들고, 실제 비트맵은 `assets.js`
  레지스트리에 산다. 그래서 히스토리 200단계가 실질적으로 공짜다. 되돌리기 기능을
  나중에 넣으려다 포기하는 흔한 패턴을 처음부터 피했다.
- **렌더 함수가 하나다.** `drawScene()`을 화면과 내보내기가 배율만 바꿔 공유하므로
  "미리보기와 결과물이 다르다"가 발생할 수 없다.
- **GIF 인코더가 스트리밍이다.** 프레임을 받는 즉시 압축하고 차분용 인덱스
  프레임 1장(1byte/px)만 남긴다. 2배율 300프레임 = RGBA 3.7GB를 메모리에 올리지
  않는다.

의존성은 CDN 폰트 2종(jsdelivr)뿐이고 GIF 코덱까지 자체 구현이다. 인코더→디코더
왕복 테스트를 돌려본 결과 프레임 수·딜레이·픽셀이 정확히 복원되고, Pillow 등
외부 디코더로도 정상 판독된다.

---

## 2. 고쳐야 할 것

### (A) 저장 상태 마이그레이션이 없다 — 실제 크래시 위험

`state.js`의 `load()`가 얕은 병합이다.

```js
this.state = { ...defaultState(), ...state };
```

`config.js`의 `TEXTS`에 항목을 하나 추가하면, 기존 사용자의 IndexedDB에 저장된
`texts` 객체가 통째로 기본값을 덮어쓴다. 새 키가 없는 채로 `renderer.js`가
`state.texts[t.key].text`를 읽어 **TypeError로 앱이 백지가 된다.**
새로고침해도 저장된 상태를 다시 읽으므로 스스로 못 빠져나온다.

README에 "칸 위치를 바꾸려면 config.js만 고치면 된다"고 적혀 있는데, 정확히 그
작업이 기존 사용자를 깨뜨린다. `v: 1` 필드는 저장은 되지만 검사하지 않는다.

수정 방향 — 키 단위 병합 + 버전 체크:

```js
load(saved) {
  const base = defaultState();
  if (saved.v !== base.v) { /* 마이그레이션 또는 폐기 */ }
  for (const k of Object.keys(base.texts))
    if (saved.texts?.[k]) base.texts[k] = { ...base.texts[k], ...saved.texts[k] };
  for (const k of Object.keys(base.slots))
    base.slots[k] = saved.slots?.[k] ?? null;
  base.effects = { shadow: {...base.effects.shadow, ...saved.effects?.shadow},
                   outline: {...base.effects.outline, ...saved.effects?.outline} };
  base.font = saved.font || base.font;
  this.state = base;
  ...
}
```

슬롯은 `p?.asset` 옵셔널 체이닝 덕에 살아남지만 텍스트는 방어가 없다.

### (B) GIF 재생 속도가 최대 11% 어긋난다

`encoder.js`의 `addIndexed()`가 프레임마다 독립적으로 반올림한다.

```js
let cs = Math.round(delayMs / 10);
```

GIF 딜레이 단위가 1/100초라 30fps(33.33ms)는 3cs=30ms가 되어 **실제로는 33.3fps로
11% 빠르게 재생**된다. 15fps는 70ms가 되어 5% 느리다. 10/20/25fps만 정확히 맞는다.

누적 오차를 다음 프레임으로 넘기면 해결된다.

```js
this._carry = (this._carry || 0) + delayMs;
let cs = Math.max(2, Math.round(this._carry / 10));
this._carry -= cs * 10;
```

### (C) tenka.png가 중복 + 8배 과대

`tenka.png`와 `old/tenka.png`가 **바이트 단위로 동일한 721KB 파일**이다. 저장소에
1.4MB가 들어 있고, 첫 로딩 시 배경 한 장에 721KB를 받는다.

| 형식 | 용량 |
|---|---|
| 현재 (PNG RGBA) | 721 KB |
| PNG 256색 | 139 KB |
| WebP q90 | **91 KB** |

투명도 있는 1024×765 일러스트라 WebP로 8배 줄여도 육안 차이가 없다. `old/old.html`은
루트 이미지를 참조하도록 고치고 중복본을 지우면 저장소도 절반이 된다.

### (D) 잔여 쓰레기 파일

`src/gif/g`, `src/workers/w`, `old/old` — 각각 개행문자 1바이트짜리 빈 파일이다.
편집기 오타(`git` 대신 `g` 저장 등)로 보인다. 삭제 대상.

---

## 3. 개선 여지 (버그는 아님)

**CDN 단일 장애점.** 폰트가 전부 jsdelivr에 걸려 있고 `font-display: block`이라
CDN이 느리면 텍스트가 렌더될 때까지 캔버스 글자 크기 계산이 멈춘다.
`main.js`에 2.5초 타임아웃이 있어 앱이 죽지는 않지만, 폰트 없이 그려진 뒤 늦게
바뀌면 자동 크기 맞춤 결과가 달라진다. woff2 두 개(합쳐도 수백 KB)를 저장소에
직접 넣으면 이 변수가 사라지고 오프라인에서도 돈다.

**공유 메타태그가 없다.** 커뮤니티에 링크를 뿌리는 성격의 도구인데
`og:image` / `og:title` / favicon이 전부 없다. 디스코드·트위터·카톡에 붙였을 때
미리보기가 안 뜬다. 4줄이면 해결된다.

**텍스트 히트박스가 넓다.** `interact.js`의 `hitTarget()`이 글자가 아니라 상자
전체로 판정한다. 좌상단 문구 상자(215×330)와 말풍선 슬롯이 x=200~216 구간에서
겹치고, 텍스트가 먼저 검사되므로 그 띠에서는 사진을 못 고른다. 빈 곳을 눌러
선택 해제하려 해도 문구가 잡히는 것도 같은 원인이다.

**용량 추정의 메모리 피크.** `estimateGifSizes()`가 2배율에서 2048×1530 ImageData를
최대 5장(약 63MB) 동시에 들고 있다. 모바일 사파리에서 탭이 죽을 수 있는 크기다.
샘플을 순차로 처리하고 즉시 버리면 12MB로 내려간다.

**PWA 미구성.** manifest도 서비스워커도 없다. 완전 클라이언트 사이드 앱이고
IndexedDB로 작업까지 보존하는데 오프라인이 안 되는 건 아까운 지점이다.

---

## 4. 처리 현황

| 항목 | 상태 |
|---|---|
| 상태 마이그레이션 (A) | ✅ 적용 |
| GIF 딜레이 누적 보정 (B) | ✅ 적용 |
| 쓰레기 파일 삭제 (D) | ✅ 적용 |
| 텍스트 히트박스 정밀화 | ✅ 적용 |
| tenka.png 최적화 | ⛔ 보류 — 화질 열화 불가 방침 |
| og 메타 + favicon | ⛔ 보류 — 불필요 판단 |
| 폰트 셀프 호스팅 | ⛔ 보류 — CDN 유지 방침 |

### 적용 내역

**`src/config.js`** — `migrateState()` 신규. 저장본을 키 단위로 병합하고 숫자·색·문자열
타입과 범위를 검증한다. `SLOTS`/`TEXTS`에 항목을 추가해도 기존 사용자 저장본이
앱을 깨뜨리지 않는다.

**`src/state.js`** — `load()`가 얕은 병합 대신 `migrateState()`를 거친다.

**`src/gif/encoder.js`** — `_takeCs()` 신규. 센티초 반올림에서 버려진 시간을 다음
프레임으로 이월한다. 프레임 병합(`_extendLastDelay`) 경로에도 같은 이월을 적용해
병합이 일어나도 전체 길이가 보존된다.

**`src/interact.js`** — `textHit()` 신규. 렌더러와 동일하게 줄을 나눠 각 줄의 실제
글자 폭으로 판정한다(여유 8px). 빈 문구는 클릭을 먹지 않고, 이미 선택된 문구만
상자 전체를 잡아 드래그 도중 놓치지 않게 했다.

### 검증

- 마이그레이션 13건: 키 누락 보충, 사용자 값 보존, NaN·타입 불일치·범위 초과 방어, 쓰레기 입력
- GIF 타이밍 8개 조합(12·15·20·24·25·30·50fps, 프레임 병합 포함): 전부 오차 0.00%
  (보정 전 30fps는 −10%, 24fps는 −4%)
- 인코더→디코더 왕복 및 Pillow 판독: 프레임 수·딜레이·픽셀 회귀 없음
- 히트박스 8건: 여백 통과, 말풍선 겹침 구간(x≈208) 해소, 자동 크기, 여유 경계
- 전 모듈 문법 검사 통과
