---
name: funnel-optimize
description: >
  PostHog 데이터 기반 퍼널 최적화 자동화 파이프라인.
  Discovery 모드 (프로젝트 분석 → KPI 설계 → config 생성) +
  Operate 모드 (7-Phase 운영: 데이터 수집 → 진단 → Triple-Agent 실험 설계 → 구현 → PR).
  "퍼널", "전환율", "CTR", "실험", "A/B 테스트", "PostHog", "KPI", "결제 개선", "공유율" 등 관련 요청 시 사용.
  `/funnel-discover`, `/funnel-optimize` 슬래시 명령으로 호출.
---

# Funnel Optimization Pipeline

PostHog 데이터 기반 퍼널 최적화 자동화. Triple-Agent(Claude+Codex+Gemini, Codex/Gemini는 optional) 경쟁으로 최적 실험 설계 + 자동 구현 + PR 생성.

## 두 가지 모드

### `/funnel-discover` (한 번 — 첫 설치 시)

새 사용자가 자기 프로젝트의 KPI를 설계. Phase D-1~D-4:

1. **D-1: 프로젝트 분석** — `node scripts/funnel-automation/discover.mjs --phase D-1`
2. **D-2: PostHog 이벤트 카탈로그** — `node scripts/funnel-automation/discover.mjs --phase D-2`
3. **D-3: KPI 인터뷰** — interview prompt 생성. Claude Code가 사용자에게 6개 질문:
   - North Star metric
   - Real revenue event (proxy 아님)
   - Value moment event
   - 1~3개 P0 KPI 정의
   - allowed_files
   - allowed_domains
4. **D-4: Config 생성** — `node scripts/funnel-automation/discover.mjs --phase D-4 --interview-result '<JSON>'`

완료 후 `funnel-config.json` 생성됨. 사용자 검토 → 첫 dry-run:
```
node scripts/funnel-automation/collect-data.mjs --days 7
```

### `/funnel-optimize` (매주 — 운영 모드)

7-Phase 자동 실행. 자세한 절차는 `docs/operate-mode.md` 참조.

## 실행 전 체크리스트

1. `.env`에 `POSTHOG_API_KEY`, `POSTHOG_PROJECT_ID` 존재
2. `funnel-config.json` 작성됨 (없으면 `/funnel-discover` 먼저)
3. `FUNNEL_STATUS.md` 읽어 현재 상태 파악
4. `.funnel-state/autoresearch/.lock` 없음 (있으면 대기)

## 7-Phase 실행 절차 (Operate 모드)

### Phase 1: 데이터 수집 + 실험 평가

```bash
node scripts/funnel-automation/collect-data.mjs --days 7
node scripts/funnel-automation/evaluate-experiment.mjs
```

**평가 결과 해석**:
- `action: none` → Phase 2 진행
- `action: continue` → Phase 2 진단만, Phase 3 스킵
- `action: winner_test|winner_control` → Phase 5 (결과 분석)
- `action: killed` → Phase 5-C (코드 정리) → Phase 3

**수동 Kill**: `node scripts/funnel-automation/evaluate-experiment.mjs --kill`

**조기 종료**: min 3일 + 500 노출 + p<0.05 → 자동 결정 (config의 `min_early_decision_days`, `min_sample_size`, `significance_level`)

### Phase 2: 진단 분석

`.funnel-state/latest-snapshot.json` 읽고 분석:

1. 퍼널 전환율 (단계별)
2. 디바이스 코호트 (mobile/desktop/tablet)
3. 언어 코호트
4. 유입 소스
5. Value Metrics (LIR, TTV, Health Rollup)
6. KPI 대시보드 (현재 vs 목표 vs WoW)
7. 가드레일 점검

분석 결과를 `FUNNEL_OPTIMIZATION_REPORT.md`에 append.

**원칙**:
- 한국어/영어 (사용자 언어)
- 정확한 수치 인용
- 가장 큰 이탈 구간 명확히 식별
- 임팩트를 매출로 환산

### Phase 3: Triple-Agent 실험 설계

> Phase 1에서 `continue`이면 스킵.

#### 3-A: Claude 자체 분석
PM Skills(`/discover`, `/brainstorm`) 사용. 출력 `.funnel-state/proposals/claude/`

#### 3-B: Codex CLI (있을 때)
```bash
bash scripts/funnel-automation/run-codex-agent.sh
```

#### 3-C: Gemini CLI (있을 때)
```bash
bash scripts/funnel-automation/run-gemini-agent.sh
```

3-B/3-C는 백그라운드 병렬 실행. 30분 timeout.

**Codex/Gemini CLI 미설치 시 자동 skip** (single-agent 모드).

#### 3-D: 2-Layer 비교

**Layer 1 자동 스코어링**:
```bash
node scripts/funnel-automation/compare-proposals.mjs
```

**Layer 2 AI PM 판단**: 6차원 평가(Discovery 품질, 데이터 인사이트, 가설 엄밀성, 전략적 정렬, 실험 안전성, 고유 인사이트). Layer 1 순위 뒤집기 가능.

선택 결과 → `.funnel-state/experiment-plan.json`. 차순위 → `.funnel-state/proposals/next-candidate.json`

### Phase 4: 실험 구현

```bash
node scripts/funnel-automation/implement-experiment.mjs
```

자동 처리:
- 이전 활성 실험 flag 비활성화
- 트래픽 균등 배분 (variant 수에 따라)
- 빌드 검증 (사용자 프로젝트의 build 명령)
- 실패 시 자동 롤백

### Phase 5: 결과 분석 (실험 종료 시)

1. 통계적 유의성 (p < 0.05)
2. 세그먼트별 효과
3. 멀티베리에이트: variant별 개별 분석
4. **Ship 결정은 실 매출(real revenue) 지표로** — proxy CTR로 SHIP 금지
5. Ship / Extend / Kill 결정

학습 기록을 `FUNNEL_OPTIMIZATION_REPORT.md`에 추가.
피드백 루프 업데이트:
```bash
node scripts/funnel-automation/feedback-loop.mjs --ingest
```

### Phase 5-C: 코드 정리 (Kill/Ship 후 필수)

1. PostHog flag 비활성화 확인
2. 컴포넌트에서 `useExperiment()` 코드 제거
   - Kill → control 코드만 남김
   - Ship → test 코드만 남김
3. 빌드 검증
4. state.json 업데이트

### Phase 6: 그로스 루프 (분기 1회)

5가지 루프 유형(Viral, UGC, Usage, Referral, Collaboration) 평가.

### Phase 7: 아카이브 + 커밋

```bash
node scripts/funnel-automation/archive.mjs

# FUNNEL_STATUS.md 업데이트 (직접)
# Git commit + PR
git checkout -b funnel/weekly-{날짜}
git add FUNNEL_OPTIMIZATION_REPORT.md FUNNEL_STATUS.md .funnel-state/ docs/funnel-archive/
git commit -m "chore: weekly funnel optimization — {날짜}"
git push -u origin funnel/weekly-{날짜}
gh pr create --title "[Funnel] Weekly — {날짜}" --body "..."
```

## experiment-plan.json 스키마

```json
{
  "action": "implement",
  "hypothesis": "XYZ 가설",
  "opportunity": "OST 기회",
  "assumption_category": "Value|Usability|Viability|Feasibility|Ethics",
  "assumption_risk": "High|Medium|Low",
  "target_kpi": "<config의 kpi 키>",
  "flag_key": "funnel-exp-YYYYMMDD-short-name",
  "experiment_name": "이름",
  "description": "설명",
  "variant_description": { "control": "...", "test": "..." },
  "code_changes": [
    {
      "file": "<config.guardrails.allowed_files 중 하나>",
      "description": "변경 설명",
      "old_code": "현재 코드 (정확한 문자열, 파일에서 유일)",
      "new_code": "새 코드 (유효한 코드)"
    }
  ],
  "success_metric": {
    "event_numerator": ["click_event"],
    "event_denominator": "impression_event",
    "target_lift": 30
  },
  "estimated_duration_days": 7
}
```

## 핵심 원칙 (animalface 7주 학습 반영)

### 1. Real revenue over vanity
- Ship 판정은 실 매출(`config.optimization_targets[].priority=P0`) 지표로
- CTR/체크아웃 진입 같은 proxy로 Ship 금지

### 2. 구조적 변경 우선
- CTA 문구만 바꾸는 실험은 보통 실패 (animalface는 3회 연속 실패)
- 위치 변경, 타이밍 변경, 새 surface 추가가 더 강한 레버

### 3. 가드레일 엄격
- 다크 패턴 금지 (가짜 시급성/소셜 프루프)
- 보안: eval/innerHTML/외부 fetch 차단 (`config.guardrails.allowed_domains`)
- 파일 범위: `config.guardrails.allowed_files` 외 변경 금지

### 4. 누적 학습
- `feedback-loop.mjs --ingest` 실행하면 실험 패턴이 다음 prompt에 자동 주입
- "X회 연속 실패한 패턴은 시도하지 말 것" 같은 학습이 시간 누적

## gstack 관점

각 Phase에 Think→Plan→Build→Review→Ship 적용:
- **Think**: 퍼널 문제가 아니라 제품 문제로 재정의 (버그 우선)
- **Plan**: 임팩트 순 우선순위
- **Build**: 제품 품질 + 실험 코드
- **Review**: 빌드 + 타입 체크
- **Ship**: 커밋 + PR + 배포

## 참고 자료

- 사례 연구: `examples/animalface/case-study.md` — 7주 18,000명 검증
- 커스터마이징: `docs/customization.md`
- FAQ: `docs/faq.md`
