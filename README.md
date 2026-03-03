# MAGI: AI-Powered Editorial Board

**MAGI** is a multi-model AI editorial board that evaluates news articles for framing bias and evidentiary sufficiency. It assembles a panel of AI personas — each running on a different LLM (Claude, GPT-4, Gemini, DeepSeek, etc.) — who debate whether an article should be published, then synthesizes their findings into a structured editorial report.

Built as a static client-side web app. No server, no database, no backend. Everything runs in your browser. This is just a prototype for research and there will be more (better) versions of this in the future once users start trying this out and sending me some sweet sweet data donations!

I made this because it pisses me off how some newsrooms cover global conflict, police-involved shootings, and other issues pertaining to marginalized communities which they are not a part of. The idea here is not to *replace* editors, but *supplement* the decision-making process with an additional layer of transparency. These simulated back-and-forths will hopefully open a window into perspectives you are otherwise not taking into account. 

## How It Works

1. **Connect** — Enter your [OpenRouter](https://openrouter.ai/keys) API key (BYO key, ~$0.10–$0.50 per run). You will need your own key to try this out.
2. **Input** — Upload a `.docx` / `.pdf` or paste article text
3. **Board** — AI analyzes the article and recommends 3–8 editorial personas with diverse stances and model assignments. You can edit roles, stances, and models before proceeding. Of course the bigger the board the longer it takes, so choose your board wisely. You can add or remove personas, assign different roles to different LLM families, diversify as much as possible and figure out what works best!
4. **Debate** — Each persona evaluates the article sequentially via streaming, referencing and challenging previous speakers by name. It simulates a chat.
5. **Report** — A final synthesis produces a structured editorial board report with verdict, framing assessment, evidence audit, fault lines, and dissenting opinions. This is a gentle guideline, some friendly suggestions. Not meant to replace human oversight. 

## What It Evaluates

Every persona assesses the article against two primary editorial priorities:

- **Framing Analysis** — Selective sourcing, loaded language, analogy proportionality, omission, structural emphasis, right of reply
- **Evidentiary Sufficiency** — Claim-to-evidence matching, source authority, characterization accuracy, causal claims, confidence vs. evidence strength

## Why Multi-Model?

Different LLM families have different training data, different biases, different reasoning patterns. By routing each persona through a different model family, you get genuine cognitive diversity — not just prompt-engineered diversity running on a single set of weights.

## Tech Stack

- **Zero dependencies to install.** Pure HTML/CSS/vanilla JavaScript (ES modules)
- **CDN libraries:** mammoth.js (DOCX parsing), pdf.js (PDF parsing), marked.js (Markdown rendering)
- **API:** OpenRouter (OpenAI-compatible gateway to 100+ models)
- **Security:** Subresource Integrity on all CDN scripts, Content Security Policy, HTML sanitization on all LLM output

## Export Formats

- **Markdown** (`.md`) — The editorial report
- **JSON** (`.json`) — Full session data (article, personas, verdicts, report)
- **CSV** (`.csv`) — Board constitution + debate transcript + report (for spreadsheet analysis)

## Privacy

Your data stays in your browser. Articles and API keys are never sent to us — only directly from your browser to OpenRouter's API for AI processing. Your API key is stored in your browser's localStorage; use the "Clear Key" button when on shared computers.

## Project Structure

```
editorial-board/
├── index.html          # Single-page app with 5 screen sections
├── css/styles.css      # Evangelion-inspired dark UI theme
├── js/
│   ├── app.js          # Main controller: state, navigation, DOM wiring
│   ├── api.js          # OpenRouter API client (streaming + non-streaming)
│   ├── board.js        # Persona generation, editorial prompts, debate orchestration
│   ├── parser.js       # Client-side DOCX/PDF parsing
│   └── report.js       # Report synthesis, rendering, CSV/MD/JSON export
└── README.md
```

## Created By

**Areeba Fatima** 
Send me your thoughts, feelings, and CSVs at af3618@columbia.edu 
If you are in NYC and would like to chat about this in person, reach out!
