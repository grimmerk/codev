# Session 尋找體驗改善計畫(search / browse / pins / preview)

> **狀態:已定案;Batch 1 進行中**(2026-07-12 brainstorm 定稿)。
> PR-1「search & noise」(§4.1–§4.3:B2 highlight + A1/B1 全量搜尋 + C1 摺疊)= **PR #132**;
> PR-2「pins」(§4.4 D1,含 C1 的手動 hide)尚未開工;Batch 2/3 未開工。
> 本文件是跨 session / 跨 model 的實作依據:所有「決策」都已跟使用者逐點確認,
> 不要重新開放已定案的選項;實作細節(§4–§6)則可依實況調整。
> 相關文件/issue:`docs/pin-feature-handoff.md`(pin 前期研究,其 §4 [FACT] 全部仍有效)、
> issue #106(session list perf)、#66(detail view 構想)、#105(real-time preview)。

## 1. 問題定義

使用者找 session 的痛點(原話重點):
1. 搜尋只涵蓋 1st user message / final AI message / final user message / branch / custom title / AI title / PR link,無全文搜尋 → 命中率低。使用者習慣為非一次性 session 手動加 custom title 來補償。
2. match 落在 UI 截斷區時,highlight 根本看不到(有 match 但不知為何 match)。
3. highlight 顏色對比不足(淡灰底疊在 orange/green 文字上幾乎隱形)。
4. 對照 Notion 的經驗:**(a) 驗證候選超便宜**(點一下右欄立刻看到內容,錯了就下一個)、**(b) noise 少**。CodeV 驗證一個候選 = 開 terminal → resume → 等載入,成本高;且列表混著大量一次性 junk session(如 `!command claude auth status` 的 1-msg session)。

分析框架 —— 找 session 有三條互補路徑 + 一個放大器:
- **A. 記得關鍵字** → 搜尋涵蓋面(資料層)
- **B. 搜尋結果可信可讀** → match 呈現(呈現層)
- **C. 認得樣子** → 肉眼瀏覽(signal/noise)
- **D. 重要的常駐** → pins(不用找)
- **放大器:快速 verify(preview)** —— 讓 A–D 每項價值翻倍

## 2. 實測數據(2026-07-12,使用者機器)

| 項目 | 數值 | 含義 |
|---|---|---|
| Transcripts | personal 868MB / 549 檔 + work 26MB / 39 檔 ≈ **894MB / 588 檔** | SQLite FTS5 或 on-demand `rg` 都可行,不需 Rust/外部 engine |
| `history.jsonl` | 15,324 行 prompt、**414 unique sessions**、6.7MB(work 帳號 142 行/50KB) | 每行 = 一個完整 user prompt(`display` 欄位,實測最長 9,224 字,**未截斷**)|
| Transcript 保留 | 最舊 2026-04-09(約 3 個月) | Claude Code `cleanupPeriodDays` 會清舊 transcript;**FTS index 建好後兼作永久文字備份**(過期 session 可讀不可 resume)|
| 現行搜尋範圍 | **實際只搜已載入的 ~100 個**:搜尋是 renderer 的 `filterSessionsLocally`(`switcher-ui.tsx:384`)client-side filter;main-side `searchClaudeSessions`(pool 500)IPC/preload 全接好但**無人呼叫 = dead code**(issue #131)| 以 414 sessions 計,**~314 個 session 今天完全搜不到**(也不會顯示)→ A1 從加分升級為必要;cache 本存全量(`claude-session-utility.ts:178`),放寬零成本 |

參考專案調查結論:**沒有人靠黑科技**。claude-code-history-viewer(Tauri+Rust)的搜尋只是 Web Worker 裡 client-side 全掃,真正價值是 conversation reader;c9watch 也是暴力掃 JSONL;raine/claude-history(Rust TUI)有 field-aware lexical + local embedding hybrid,但我們不需要到那程度。TencentDB-Agent-Memory 是純 local(SQLite+sqlite-vec)但解的是 agent 長期記憶,非人找 session,略過。

## 3. 已定案決策(與使用者逐點確認,勿重開)

| # | 決策 | 理由 |
|---|---|---|
| 1 | **C2 compact/title-only mode:不做** | 使用者已習慣為非一次性 session 加 title,搜尋目標多為這類 |
| 2 | **A2' rg 過渡版:不做,直接做 A2 FTS5 完整版** | 使用者:要做就做完整版 |
| 3 | **A2+ file-path 反查:降為小加分**,做 A2 時順手才做 | |
| 4 | **A3 semantic/vector、E ask-AI、Tencent memory:park** | FTS+preview 上線後再評估剩餘痛點 |
| 5 | **C4 preview 提前**(使用者:有 C4 是否還需 B1?→ 見 §5.1;B1 獨立項取消,併入 A1 與 A2)| |
| 6 | **B2 highlight 顏色:立刻做**(純 CSS)| |
| 7 | **C1 junk 摺疊:做**,利用「無 custom title + 極少 msgs」當 signal | 對應 Notion noise 少的優勢 |
| 8 | **D1 pin UI:做**(spec 見 §4.4);**D3 in-session `/pin`:Batch 3**,走 custom slash command、接受一次 LLM turn | 使用者原勉強接受 `!` 路徑但不喜歡沒自動完成;slash command 在 Claude Code 內建 autocomplete,且 `!` 路徑的「不經 LLM」賣點已被實測推翻(見 §7)|
| 9 | AI 自動 summary/grouping:不做批次版;改 **A4-lite**:preview 內「Generate title」按鈕(haiku,寫入 custom title,貼合手動 title 習慣)| 使用者對 AI title 品質存疑,heuristic 先行 |

**否決記錄(留檔備查,含重開條件):**
- **C2 compact/title-only mode**:原構想 = Notion cmd+P 風格,有 title 的 session 只顯示一行 title、untitled 才展開三行,提升肉眼掃視密度。砍因:使用者搜尋目標多為已加 title 的非一次性 session,C1(去噪)+ C4(快速驗證)已覆蓋掃視需求。重開條件:Batch 1/2 上線後肉眼瀏覽仍吃力。
- **A2' rg deep-search 過渡版**:原構想 = 按 Enter 才 shell out 到 ripgrep 掃 894MB transcripts(2–3 天可上線,零索引維護),當 FTS 前的需求驗證。砍因:使用者拍板直接做 FTS5 完整版,不花過渡功。殘值:`rg` 一次性掃描仍是**索引除錯工具**(驗證 FTS 增量索引有沒有漏資料),實作 A2 時可當 debug 手段,不做成產品功能。
- **A3 semantic/vector、E ask-AI、Tencent memory**:park 而非砍——重開條件:FTS + preview 上線後「憑概念找但想不起關鍵字」仍是常見失敗模式。

## 4. Batch 1 —— 快贏(每項 S effort)

### 4.1 B2:highlight 對比修正(hours)
現況:淡灰底 box。改成 amber/yellow 底 + 深色字(或 theme accent + bold),確保在 orange(1st msg)/green(title)/白色文字上都可讀。純 CSS,`switcher-ui.tsx` 的 highlight 渲染處。

### 4.2 A1+B1 合併:全 session × 全 user-prompt 搜尋 + match snippet(修 issue #131)
- **現況(issue #131)**:搜尋 = renderer `filterSessionsLocally`(`switcher-ui.tsx:384-393`)只 filter 已載入的 ~100 個;main-side `searchClaudeSessions`(`claude-session-utility.ts:186`,pool 500、上限 50)是 IPC/preload 全接好但無人呼叫的 **dead code**。⇒ ~314/414 個 session 今天完全搜不到。
- **為何跟 snippet 合併**:全 prompt 搜尋的 match 多半落在「中段 prompt」——UI 本來就不顯示 → 沒有 snippet 等於白搜。兩者是一個 feature。
- 資料:`history.jsonl` 每行一個 prompt;現在 `SessionAccum` 只留 first/last、中間丟棄(`claude-session-utility.ts:115-150`)。改法:掃描時另建 **main-process 模組級** `Map<sessionId, string[]>`(全部 prompts,~+7MB RAM)。
- **設計:雙路 union**(因為 enrichment 欄位只存在 renderer、且只有已載入的 ~100 個有):
  1. main-side search IPC(重寫或取代 dead 的 `searchClaudeSessions`):搜**全部** sessions 的 project name + **全部 prompts**,回傳 matched sessions + `matchedSnippet`(match 為中心前後 ~40 字)+ `matchedField` badge(prompt#N / project / …)。
  2. renderer 保留 `filterSessionsLocally`(cover branch / PR / AI response / custom title 等 enriched 欄位)。
  3. 兩路 union;main-side 命中但不在已載入 100 內的 session **append 進列表 + lazy enrichment**。
- **重要:不要把全部 prompts 塞進 IPC 回傳的 session 物件**(每次傳 7MB 會炸掉效能)。
- Renderer:match 不在可見欄位時,該 row 的一行換成 snippet 顯示。
- 效能:6.7MB in-memory string scan ≈ 5–20ms/query,加 debounce 無感;**不影響 list update 路徑**(那是 #106 的 IPC/process-scan/enrichment 成本,正交)。

### 4.3 C1:junk session 摺疊
- 判準(全部符合才摺):`messageCount ≤ 2` **且** 無 custom title **且** 無 PR link **且** 非 active。
- UI:摺成一行灰色「· N minor sessions」(可展開);另提供 row 右鍵「Hide session」手動隱藏(進 §4.4 同一個 store 的 `hidden` 清單)。
- 保守優先:誤摺(展開就看得到)好過誤藏。

### 4.4 D1:Pin ★ + Pinned section
前期研究見 `docs/pin-feature-handoff.md`(其 §5 [REC] 是本設計的底,以下含 multi-account 時代的偏離)。

**UI spec(已向使用者提案):**
- Session row hover 時右側出現 📌 按鈕,click toggle;已 pin 的 row 顯示常駐小 ★。
- Sessions list 頂部:collapsible「📌 Pinned (N)」section,預設展開;row 完整重用既有 session row(status dot / badge / PR / title 全保留)。
- Pinned session **同時**仍出現在時間軸原位(帶 ★)——section 是捷徑不是搬家(Notion favorites 同樣兩處都在)。
- 搜尋時:pinned section 隱藏,結果統一列出(match 到的 pinned row 帶 ★)。
- Unpin:pinned row hover-`x`(recent projects 已有同 pattern)或再點 📌。
- Empty state 提示一行。
- v1 排序:pinnedAt desc;群組(named groups)是 v2(store schema 先留 `group?` 欄位)。

**Store(偏離 handoff [REC] 的理由:multi-account 時代 + 要放 hidden 清單):**
- 單一檔 `~/.config/codev/session-marks.json`(跨帳號一份;`~/.config/codev/` 已是 accounts registry 所在):
  ```json
  { "pins": { "<sessionId>": { "pinnedAt": "…", "cwd": "…", "accountLabel": "…", "group": null } },
    "hidden": ["<sessionId>", "…"] }
  ```
- `fs.watch` 同 status-files pattern(`session-status-hooks.ts` 是範本)。

**sessionId 穩定性(2026-07-12 已驗證,設計因此大幅簡化):**
- [FACT] Claude Code 2.1.207:`--resume` / `--continue` **預設沿用原 sessionId、續寫同一個 transcript 檔**;產生新 id 是 opt-in 的 `--fork-session`(help 原文:「When resuming, create a new session ID **instead of reusing the original**」)。使用者日常觀察一致(同一 row 的 msgs 數跨 resume 累積)。
- ⇒ **pin 用 sessionId 當 key 就夠了**,一般 resume 不需要任何遷移機制。
- 邊界情況(v1 一律不處理,遇到就手動 re-pin):明確 `--fork-session`、cross-account copy-fork(issue #128)。

## 5. Batch 2 —— 結構性投資

### 5.1 C4:Preview / 詳情(v1 card → v2 pane)
- 對應 issue #66 的「detail view」與 #105;解掉「要 resume 才能驗證」的根本瓶頸(Notion 右欄的對應物)。
- **v1(card)**:點 row(或按 Space)展開 in-place detail card:custom/AI title、完整 first/last message、branch、PR、msgs、account、時間 + 最後 N 則訊息的文字摘要。
- **v2(pane/reader)**:list 左 + read-only transcript reader 右:lazy-load 最後 N 則、markdown 渲染(AI Chat tab 已有 md renderer 可重用)、tool call 摺成 one-liner chips、**從搜尋進來自動 jump-to-match**(A2 上線後 match 定位由 FTS 提供)。
- 「有 C4 還要 B1 嗎?」的定案:兩者服務不同步驟——B1 讓你**掃 list 就知道為何 match**(不用逐個打開),C4 讓你**深看單一候選**。但 B1 的獨立工作量已被吸收:prompt match 的 snippet 在 §4.2 做掉,transcript match 的 snippet 由 A2 的 `snippet()` 免費提供 → **不存在獨立的 B1 工項**。
- 讀 transcript 注意:行內含 base64 圖片與大型 tool_result,只抽 text block 渲染;檔案可能很大(本 session 檔就數十 MB),要 tail-read + 分頁。

### 5.2 A2:FTS5 全文索引(完整版,不做 rg 過渡)
- Engine:**better-sqlite3(已是依賴)+ FTS5**。DB 放 `~/.config/codev/search-index.db`。
- Schema 草案:`messages(session_id, account, project, role, ts, text)` + FTS5 virtual table(content 外部表或 contentless 皆可);另表 `files(path, mtime, bytes_indexed)` 記增量進度。
- **增量索引**:transcript 是 append-only → 記 per-file byte offset,只 parse 新增部分;掃描時機:app focus / 定時 / session end。首次全量建置放 background(chunked,別卡 UI)。
- **抽取規則 v1**:user + assistant 的 text block;**排除** thinking、tool_use/tool_result、base64。tool output 索引(對「哪個 session 碰過檔案 X」有用)留為 flag/v2,即 A2+ file-path 反查(從 tool_use 參數抽 file_path 建小倒排,順手才做)。
- **CJK 陷阱與解法**:FTS5 trigram tokenizer 需 ≥3 字,「上限」這種 2 字詞會 miss → **索引與查詢時把 CJK 連續段預切成空白分隔的 bigram**(ASCII 詞保留原樣),用預設 unicode61 tokenizer。純 JS 預處理、無 native tokenizer 依賴、中英混合 query 皆可。
- 排序:bm25 × recency;`snippet()` 直接供 B1/C4 用。
- Multi-account:一顆 DB、`account` 欄;掃描來源用既有 `getScannableAccounts()`。
- 重複內容:一般 resume 沿用同檔(§4.4),無跨檔重複;只有明確 `--fork-session` 產生祖先/後代重複 match,罕見,v1 不處理。
- 過期 session(transcript 已被 cleanup 清掉):index 保留文字 → 結果標「expired」(可讀不可 resume)。

## 6. Batch 3 —— 看手感加

| 項 | 內容 | 備註 |
|---|---|---|
| D3 `/pin` | Custom slash command:利用 Claude Code 的 slash **autocomplete**(解使用者對 `!` 無補全的不滿);command 內跑 `codev pin`,sessionId 取自 **`CLAUDE_CODE_SESSION_ID` env var**([FACT],見 §7);接受一次 LLM turn(使用者已表態可接受)。可帶參數 `/pin as "…"` | UI pin 仍是 primary |
| B4 filters | `project:` `branch:` `account:` `has:pr` `msgs:>10` `after:` chips | |
| A4-lite | Preview 內「Generate title」按鈕(haiku、寫 custom title) | 不做批次 auto-summary |
| C3 chain collapse | **基本作廢**(2026-07-12):一般 resume 沿用同 sessionId(§4.4),不產生世代鏈;僅在 `--fork-session` / copy-fork 常用化時才有意義 | 留檔備查 |

## 7. 關鍵技術事實(gotchas —— 實作前必讀)

1. **In-session typed trigger 沒有乾淨路徑**([FACT],`pin-feature-handoff.md` §4 實機驗證):`/pin` 會觸發 LLM turn;**`!` bash-mode 也會**(輸出會送進 model——文件宣稱不會,實測會);`UserPromptSubmit` hook block(exit 2)不觸發 turn 但必顯示 blocked notice(`suppressOutput` 壓不掉)。⇒ 別再重試「無 turn 且無 notice」的方案;D3 的定位就是「接受 turn 換 autocomplete」。
2. **`CLAUDE_CODE_SESSION_ID`** env var 存在於 session shell,值為 session UUID(不是網路上常誤傳的 `CLAUDE_SESSION_ID`)。
3. **Custom title 存在 transcript 內**:`/rename` 寫入 `"type":"custom-title"` 行;CodeV 用 grep tail -1 讀(`claude-session-utility.ts:312,413,489`)。resume 沿用同檔(fact 4)→ title 自然延續;pin 以 sessionId 為 key 同樣自然延續。
4. **Resume 語意(2.1.207 以 `--help` 驗證)**:`--resume` / `--continue` **預設沿用原 sessionId、續寫同一檔**;`--fork-session` 才產生新 id 新檔。⚠️ 舊版 Claude Code 曾預設 fork——網路舊文與舊經驗常仍這樣講,勿信(本計畫初稿就因此寫錯過一次)。
5. **history.jsonl 每行 = 一個完整 user prompt**(`display` 未截斷,實測最長 9,224 字);一個 session 多行;目前 accumulator 只留 first/last。
6. **cachedSessions 是 metadata 不是 transcript**:每 session 一筆小物件(id/project/first/last/timestamps/count/account),414 sessions << 1MB;5s TTL(`CACHE_TTL_MS`);transcripts(894MB)只在 enrichment 時對可見 ≤100 個 session 做 per-file tail read。**任何新功能都不要把大資料塞進 IPC 回傳的 session 物件。**
7. **Search pool 500**:超過後舊 session 無聲消失於搜尋;放寬 = 把 `searchClaudeSessions` 內的 `readClaudeSessions(500)` 改全量(cache 已全量,零成本)。
8. **FTS5 trigram ≥3 字** → CJK 2 字詞 miss → 用 bigram 預切(§5.2)。
9. **Transcript 行內有 base64 圖與巨大 tool_result** → 索引/渲染都只抽 text block。
10. Multi-account 一律用 `getScannableAccounts()` 迭代;跨帳號的使用者層資料(pins/hidden/index)放 `~/.config/codev/`,單一份。
11. Lint:repo 無 CI lint gate,舊檔非 prettier 格式 → **只格式化自己改的行**,新檔可全 prettier。

## 8. 開放問題(實作時再定)

- Pinned section 與時間軸「兩處都顯示」是提案預設,使用者未最終拍板(反對再改成只在 section)。
- `session-marks.json` 單檔 vs 沿用 handoff 的 `~/.claude/codev-status/pinned.json`:本文傾向前者(multi-account + hidden 清單),實作時可再議。
- C4 v1 card 與 v2 pane 是否合併一次做:視當時 effort 感覺。
- FTS 是否索引 thinking block:v1 不索引(體積/噪音),留 flag。
