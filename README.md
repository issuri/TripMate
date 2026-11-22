# TripMate

여행 준비부터 귀국까지 한 앱에서 관리하는 여행 가이드(PWA)입니다. 일정, 지도, 쇼핑, 준비물, 경비·정산, 알림을 지원하고, 국내 여행과 해외 여행을 모두 쓸 수 있습니다.

- **데이터는 사용하는 기기의 브라우저 안에만 저장됩니다.** 서버나 계정이 필요 없고, 이 저장소에도 개인 데이터는 없습니다.
- 지도는 OpenStreetMap(Leaflet), 장소 검색은 Nominatim을 씁니다. 사용 정책은 [OpenStreetMap 타일 사용 정책](https://operations.osmfoundation.org/policies/tiles/)을 따릅니다.
- 알림은 앱이 열려 있는 동안 동작합니다(앱을 닫은 뒤의 푸시 알림은 지원하지 않습니다).

## 개발

```bash
npm ci
npm run dev        # http://localhost:5173
npm test           # 단위 테스트
npm run build      # dist/ 로 빌드
```

기술: React, TypeScript, Vite, Tailwind CSS, Dexie(IndexedDB), Leaflet, Vitest.

## 배포 (GitHub Pages)

`main` 브랜치에 올리면 `.github/workflows/pages.yml` 이 테스트와 빌드를 거쳐 GitHub Pages 에 게시합니다.
저장소 Settings → Pages → Source 를 **GitHub Actions** 로 지정해야 합니다.

`아이디.github.io` 이름의 저장소로 올리면 주소가 `https://아이디.github.io/` 가 되어 별도 설정 없이 동작합니다.

## 선택 기능: 서버 동기화 (기본은 꺼짐)

내 기기끼리 동기화하려면 Supabase 프로젝트를 만들고 `supabase/migrations/` 를 순서대로 적용한 뒤, `.env.example` 을 `.env.local` 로 복사해 값을 채웁니다. 설정하지 않으면 앱은 로컬 전용으로 동작합니다. 키는 저장소에 올리지 마세요(`.env.local` 은 무시됩니다).
