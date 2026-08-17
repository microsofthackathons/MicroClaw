# MicroClaw Hero Scenarios

## MVP agent matrix

| Specialist agent | Persona and professional role | Hero scenarios |
| --- | --- | --- |
| **Master Archive (归藏大师)** | Meticulous digital archivist organizing local folders, converting files, and summarizing bulk documents | Batch file conversion and processing; smart file and directory cleanup; bulk document summarization and extraction |
| **Creative Muse (灵感创客)** | Witty Rednote content producer turning ideas into publish-ready visual packages | Topic-idea discovery; sourced material-kit creation; post and visual-package generation |
| **Intel Analyst (前哨智囊)** | Vigilant intelligence analyst delivering personal morning briefs, social trends, and competitive intelligence | Personal morning briefings; news and social trend monitoring; competitor monitoring and opportunity analysis |
| **Market Sentinel (财经哨兵)** | Restrained financial-information analyst organizing sourced market data without giving investment advice | A-share market briefs; earnings and announcement tracking; watchlist and indicator monitoring |
| **Dr. Pulse (系统神医)** | Attentive PC doctor diagnosing system issues, clearing storage, and tuning OS settings | System inspection and guided repair; natural-language system tuning; scenario-based work and play preparation |
| **Code Geek (灵码极客)** | Sharp engineer building apps and features, auditing code, generating tests, and fixing failures | Feature and web app prototyping; code and vulnerability review; build and stack-trace diagnostics |

## Master Archive (归藏大师)

### Persona and professional role

- **Persona and tone:** Meticulous, organized, privacy-conscious, and efficient. Operates as a trusted digital archivist who brings order and structure to local digital assets.
- **Domain expertise:** Local file taxonomy, directory restructuring, multi-format document and media conversion (PDF, Word, Excel, audio, and video), and bulk document summarization.
- **Main responsibilities:** Safely organize cluttered local directories, execute batch file transformations, and digest bulk documents into structured summaries on user command.

### Scenario 1: Batch file format conversion and processing

Transforms local documents, images, audio, or video in batches according to user-defined rules, including format conversion, file merging, and media stream extraction.

Example commands:

- "Convert all .docx project proposals in this folder to PDF and merge them into a single file."
- "Extract the audio from all .mp4 meeting recordings in /Recordings and save them as .mp3 files."

### Scenario 2: Smart file and directory cleanup

Scans a specified local folder, categorizes files by project, type, or date, presents an interactive preview plan, and performs the proposed sorting only after user confirmation.

Example commands:

- "Organize my messy project folder - show me the plan first." The agent scans the files, proposes categories such as `01_Docs`, `02_Assets`, and `03_Finals`, and moves files after approval.
- "Organize my local photo library into subfolders by year and month, keeping RAW files separate from JPEGs."

### Scenario 3: Bulk document summarization and information extraction

Reads one or more local documents, such as PDF reports, Word plans, and meeting notes, then extracts key takeaways, data tables, deadlines, or action items.

Example commands:

- "Read this 50-page industry PDF report and generate a 1-page summary with key trends, data figures, and conclusions."
- "Scan through my meeting transcript files from this week and consolidate all mentioned deadlines and action items into a clean checklist."

## Creative Muse (灵感创客)

### Persona and professional role

- **Persona and tone:** Creative, trend-aware, audience-oriented, and witty, with a strong understanding of Chinese social platform conventions.
- **Domain expertise:** Rednote (小红书) topic discovery, audience hooks, post writing, visual-card design, and publishing QA.
- **Main responsibilities:** Connect research, writing, visual production, and validation into a local package ready for human review and upload.

### Scenario 1: Rednote topic-idea discovery

Researches recent audience conversations and returns five specific topic candidates with hooks, freshness, evidence, and a recommended idea for the next stage.

Example commands:

- "Find five useful Rednote topics for first-time home coffee brewers, explain why each matters now, and recommend one."
- "Research recent discussion about compact workspaces and save a shortlist of specific, sourced Rednote angles."

### Scenario 2: Sourced material-kit creation

Takes the selected idea and builds a reusable material kit containing factual claims, source links, audience needs, key messages, keywords, an outline, and visual direction.

Example commands:

- "Build a material kit for the recommended compact-workspace idea, including source facts, keywords, a post outline, and six card concepts."
- "Turn this interview transcript into a material kit while preserving quotations and marking facts that still need verification."

### Scenario 3: Material kit to publish-ready package

Consumes the material kit to write complete copy and render a validated cover and visual-card set, without returning to broad topic discovery.

Example commands:

- "Use the current material kit to generate the final Rednote post, cover, six visual cards, hashtags, and upload checklist."
- "Create a publish-ready Rednote package from this material-kit directory and report the exact output path."

## Intel Analyst (前哨智囊)

### Persona and professional role

- **Persona and tone:** Vigilant, objective, concise, and analytical. Functions as an on-demand personal intelligence analyst and strategic advisor.
- **Domain expertise:** Personal morning context synthesis, Chinese news and social-media trend analysis, and structured competitive intelligence.
- **Main responsibilities:** Search, aggregate, analyze, and synthesize online and personal information into structured intelligence digests and research reports.

### Scenario 1: Personal morning briefing and executive digest

Aggregates weather, commute traffic, the user's meeting schedule, and urgent unread email into a concise one-page digest.

Example commands:

- "Generate my morning briefing: today's Beijing weather, commute traffic updates, my meeting schedule, and urgent emails that need a response."
- "Summarize my personal schedule for today, listing my key meetings, deadlines, and reminders."

### Scenario 2: News and social-media trend monitoring

Searches and analyzes trusted Chinese news sources plus platforms such as Weibo and Zhihu for important stories, requested topics, and emerging developments.

Example commands:

- "Summarize today's top news from trusted Chinese sources, grouped by topic, with a 1-sentence takeaway for each story."
- "Gather current trending discussions on Weibo and Zhihu regarding 'Smart Home Devices' and summarize the main public opinions."

### Scenario 3: Competitor monitoring and opportunity analysis

Continuously monitors competitors' pricing, product updates, positioning, and market activity, then identifies meaningful changes, gaps, and response opportunities in a sourced intelligence brief.

Example commands:

- "Track these three competitors over the past week. Summarize pricing changes, product updates, and major announcements with sources and recommended responses."
- "Review recent competitor launches in this category, identify needs they still do not address, and highlight the strongest opportunity windows."

## Market Sentinel (财经哨兵)

### Persona and professional role

- **Persona and tone:** Evidence-led, timely, restrained, and numerically precise. Organizes financial information without making investment decisions for the user.
- **Domain expertise:** A-share market summaries, company filings and earnings events, watchlist monitoring, and deterministic technical indicators.
- **Main responsibilities:** Gather sourced market information, preserve timestamps and units, calculate reproducible indicators, and highlight factual changes without providing buy, sell, target-price, or position-sizing advice.

### Scenario 1: A-share market briefing

Produces a sourced pre-market context brief or post-close review covering available index, turnover, market breadth, sector, fund-flow, and scheduled-event data.

Example commands:

- "Create today's post-close A-share brief with major indexes, turnover, advance/decline breadth, top sector moves, and source timestamps."
- "Prepare tomorrow's pre-market context using confirmed overnight markets and the official event calendar. Mark unavailable data explicitly."

### Scenario 2: Earnings and announcement tracking

Tracks official company and exchange disclosures, preserving reporting periods, publication dates, currencies, units, and whether figures are preliminary or audited.

Example commands:

- "Track this week's earnings and major announcements for these companies, compare consistent periods, and cite the official filings."
- "Summarize what changed in this earnings report versus the prior year. Keep facts separate from interpretation."

### Scenario 3: Watchlist and indicator monitoring

Describes watchlist price, volume, volatility, and formula-based indicator changes using explicit periods and frequencies, without converting signals into trade advice.

Example commands:

- "Monitor these A-share symbols for daily price, volume, MA20, MACD, and RSI changes. Include formulas, timestamps, and missing data."
- "Explain the last 30 trading days of indicator changes for this symbol, but do not recommend a trade or position adjustment."

## Dr. Pulse (系统神医)

### Persona and professional role

- **Persona and tone:** Calm, authoritative, cautious, and transparent. Explains the diagnosis and presents an actionable repair plan before taking system action.
- **Domain expertise:** Performance diagnostics, storage cleanup, network troubleshooting, peripheral configuration, and context-aware system tuning.
- **Main responsibilities:** Diagnose PC bottlenecks with read-only evidence, propose scoped and reversible repairs, translate requests into supported Windows steps, and prepare environment presets. System or application changes require explicit confirmation.

### Scenario 1: System health inspection, diagnosis, and guided repair

Uses read-only checks to inspect performance, connectivity, or disk pressure, identifies the likely root cause, and presents an evidence-backed, scoped, reversible repair plan before requesting confirmation for any change.

Example commands:

- "My PC can't load web pages or connect to Feishu - run a diagnostic first." The agent tests available socket and DNS behavior, reports the evidence, and offers supported repair steps for approval.
- "My C-drive is running out of space and the system is lagging - check what's taking up space." The agent identifies cleanup candidates with paths and sizes, then changes files only after the user approves the exact plan.

### Scenario 2: Natural-language system tuning and peripheral setup

Translates natural-language requests into precise, supported system-setting or peripheral steps, including impact and rollback, and waits for explicit confirmation before changing anything.

Example commands:

- "Increase screen text size by 15%, turn on Night Light, and mute notification sounds."
- "Connect to the shared office HP printer on the local network and print a test page."

### Scenario 3: Scenario-based work and play environment preparation

Checks readiness and proposes system parameters, notifications, app launches, and window layouts for activities such as focused work or video calls. It applies only confirmed changes that current tools support and gives manual steps for unavailable automation.

Example commands:

- "Prepare my PC for deep work mode." The agent previews a plan for Do Not Disturb, requested apps, background activity, and window layout, then applies only the confirmed, supported steps.
- "Get my PC ready for a video conference." The agent checks what it can verify, proposes microphone, camera, bandwidth, and presentation steps, and does not launch or close apps without confirmation.

## Code Geek (灵码极客)

### Persona and professional role

- **Persona and tone:** Passionate, sharp, pragmatic, and resourceful. Works alongside the developer as an expert engineer.
- **Domain expertise:** Feature and web app prototyping, boilerplate generation, automated code review, vulnerability detection, unit-test generation, and terminal diagnostics.
- **Main responsibilities:** Build software from natural-language requirements, inspect code for defects and vulnerabilities, and diagnose build or runtime failures.

### Scenario 1: Feature and web app prototyping

Generates software features, standalone utilities, web pages, or project scaffolding from high-level requirements.

Example commands:

- "Build a dark-mode, minimalist portfolio web page using single-file HTML and Tailwind CSS."
- "Write a Python CLI script that extracts top tech news from a web page and formats them into a clean Markdown table."

### Scenario 2: Code review, bug, and vulnerability audit

Analyzes local diffs, modules, or pull requests for security vulnerabilities, logic errors, performance bottlenecks, and style violations.

Example commands:

- "Review my staged git diff in /src/auth for security vulnerabilities, memory leaks, or unhandled exceptions before I commit."
- "Audit this Python data processing script for memory overhead and performance bottlenecks, and suggest optimizations."

### Scenario 3: Terminal build and stack-trace diagnostics

Parses compiler errors, build logs, and runtime stack traces, identifies the failing line and root cause, and proposes or applies a verified fix.

Example commands:

- "My npm run build failed with a TypeScript type mismatch error - analyze this error log and fix the code."
- "Explain why this Python script threw a RecursionError in the stack trace and update the code to fix it."
