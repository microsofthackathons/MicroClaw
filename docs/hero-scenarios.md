# MicroClaw Hero Scenarios

## MVP agent matrix

| Specialist agent | Persona and professional role | Hero scenarios |
| --- | --- | --- |
| **Master Archive (归藏大师)** | Meticulous digital archivist organizing local folders, converting files, and summarizing bulk documents | Batch file conversion and processing; smart file and directory cleanup; bulk document summarization and extraction |
| **Creative Muse (灵感创客)** | Witty creative content strategist crafting Rednote posts, video scripts, and multi-platform text | Rednote viral seed posts; short-video storyboards and scripts; multi-platform content adaptation |
| **Intel Analyst (前哨智囊)** | Vigilant intelligence analyst delivering personal morning briefs, social trends, and competitive intelligence | Personal morning briefings; news and social trend monitoring; competitor monitoring and opportunity analysis |
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
- **Domain expertise:** Rednote (小红书) seed posts, short-video and live-stream scripts, and multi-platform copy adaptation.
- **Main responsibilities:** Convert raw ideas, product highlights, or master copy into platform-specific content packages ready for publishing.

### Scenario 1: Rednote viral seed post creation

Generates engaging, emoji-rich Rednote copy, title candidates, and structured post outlines from product features, lifestyle experiences, or local store visits.

Example commands:

- "I visited a new zen-style tea house today. Write 5 catchy Rednote titles with emojis, a 300-word review post highlighting key tea drinks, and 5 trending hashtags."
- "Write a Rednote post for a rose moisturizing cream targeting young professionals, highlighting ingredient safety and texture."

### Scenario 2: Short-video storyboarding and scriptwriting

Transforms concepts or product features into structured short-video or live-stream scripts with visual directions, audio cues, timecodes, and dialogue.

Example commands:

- "Turn this wireless earbud feature sheet into a 60-second Douyin video script with visual camera directions, sound effects, and spoken dialogue."
- "Draft an outline for a 5-minute Bilibili tech review video covering smart home gadgets, including a strong 3-second opening hook."

### Scenario 3: Multi-platform content repurposing and adaptation

Rewrites master copy into versions tailored to the style, length, and audience expectations of specific platforms.

Example commands:

- "Take my 1500-word WeChat Official Account article and adapt it into three versions: a Bilibili dynamic post, a Feishu document summary, and a Rednote card note."
- "Polish this product launch text into three different tones: casual and friendly, geeky and professional, and humorous."

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

## Dr. Pulse (系统神医)

### Persona and professional role

- **Persona and tone:** Calm, authoritative, cautious, and transparent. Explains the diagnosis and presents an actionable repair plan before taking system action.
- **Domain expertise:** Performance diagnostics, storage cleanup, network troubleshooting, peripheral configuration, and context-aware system tuning.
- **Main responsibilities:** Diagnose PC bottlenecks, fix system and network issues, simplify nested settings, and prepare environment presets for work or entertainment.

### Scenario 1: System health inspection, diagnosis, and guided repair

Inspects performance, connectivity, or disk pressure, identifies the likely root cause, and presents a repair plan before requesting confirmation to execute changes.

Example commands:

- "My PC can't load web pages or connect to Feishu - run a diagnostic first." The agent tests socket and DNS behavior, reports the cause, and offers an approved one-click repair.
- "My C-drive is running out of space and the system is lagging - check what's taking up space." The agent identifies safe cleanup candidates and executes the approved plan.

### Scenario 2: Natural-language system tuning and peripheral setup

Translates natural-language requests into precise system-setting or peripheral configuration changes.

Example commands:

- "Increase screen text size by 15%, turn on Night Light, and mute notification sounds."
- "Connect to the shared office HP printer on the local network and print a test page."

### Scenario 3: Scenario-based work and play environment preparation

Configures system parameters, notifications, app launches, and window layouts for activities such as focused work, video calls, or gaming.

Example commands:

- "Prepare my PC for deep work mode." The agent enables Do Not Disturb, launches Feishu and WPS Office, mutes background apps, and arranges windows.
- "Get my PC ready for a video conference." The agent tests microphone and camera inputs, closes bandwidth-heavy tasks, and opens the presentation.

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
