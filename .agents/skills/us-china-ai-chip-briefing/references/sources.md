# Source discovery (stage 2)

A starting framework, **not a whitelist**. Anything material to US-China AI and semiconductor competition belongs
in the sweep, wherever it is published and whoever it involves. The lists below say where important developments
usually appear first; they do not limit where you may look.

## 1. How to search (budget: roughly 15–25 searches/fetches in total)

1. **Active cases first** (Pass A). Each case in `active_cases.md` gets a decision, even "no change". Lack of news is
   not evidence of no change: check the channel named in the case.
2. **Official channels, both sides** (Pass B, ~8–12 checks). Use section 3. Prefer listings and search/API pages
   filtered to the window over home pages.
3. **Quality news by topic, not by company** (Pass C, ~6–10 queries). Search the themes in section 4 with the window
   dates; read who is involved, then go to the primary document.
4. **Deliberate exploration** (Pass D, 2–3 queries). One query for something not on any list (a new entrant,
   regulator, standard, research result, financing); follow one name that keeps recurring but is not listed here.
5. **Stop** when new queries only return events you already recorded.

## 2. What to keep (materiality test)

Keep an event when it **changes US-China competition, policy, supply chains or a financial-sector decision**
(compliance, credit, underwriting, investment, reputation), and write that link with `--why`. Hard-to-verify material
events are `track`, not `exclude`.

- Strong: export-control rules, licences, enforcement cases, entity/sanctions list changes, Chinese countermeasures
  (export controls, unreliable-entity list, antitrust, rare earths), leader/trade talks, major model or chip
  capability shifts, Chinese domestic substitution milestones, financing of AI/chip firms with a US-China angle.
- Weak by default: product launches, benchmarks and earnings **without** a US-China link. Record them as
  `excluded` with a reason, or put one line in the appendix. Do not fill the report with them because they are easy
  to find.
- Major events stay in even if hard to source: report them as 据报 with the limitation stated, never drop them silently.

## 3. Primary channels (examples; extend freely)

| Side | Body | Where | Use for / access notes |
|---|---|---|---|
| US | Federal Register | federalregister.gov; API `api/v1/documents.json?conditions[term]=…&conditions[publication_date][gte]=YYYY-MM-DD` | Rules, notices, entity-list changes. Web pages may show an access check: use the API JSON. |
| US | BIS (Commerce) | bis.gov → News & Updates; Federal Register notices | Export controls, licences, enforcement. Its notices list is dynamic: an empty list is not proof of no rule. |
| US | Commerce | commerce.gov/news | Department announcements, CHIPS Act awards |
| US | Treasury / OFAC | home.treasury.gov/news; ofac.treasury.gov/recent-actions; sanctionssearch.ofac.treas.gov | Sanctions, outbound investment rules, NS-CMIC list |
| US | USTR | ustr.gov press releases | Trade talks, Section 301, tariffs |
| US | FCC | fcc.gov/news-events | Covered List, test-lab rules |
| US | White House | whitehouse.gov (news, presidential actions) | Executive orders, proclamations, summit statements |
| US | DOJ | justice.gov/news; court dockets | Chip-smuggling and export-control prosecutions |
| US | SEC | sec.gov EDGAR full-text search | Company disclosures of China exposure, licence impacts (8-K, 10-Q) |
| US | DoD | defense.gov / war.gov releases | 1260H "Chinese military companies" list |
| US | Congress, NIST | congress.gov; nist.gov | Bills (chip export bills, NDAA); AI standards and evaluations |
| CN | MOFCOM 商务部 | mofcom.gov.cn (政策发布, 新闻发布, 新闻发言人); 安全与管制局 aqygzj.mofcom.gov.cn | Export controls, unreliable-entity list, rare earths, US-China trade talks |
| CN | MIIT 工信部 | miit.gov.cn | Industrial policy, chips, AI computing. Sometimes resets automated connections: try again, or use gov.cn / Xinhua reprints and say so. |
| CN | State Council 国务院 | gov.cn (最新政策, 政策解读) | Top-level policy documents and interpretations |
| CN | CAC 网信办 | cac.gov.cn | Generative-AI filings, data and algorithm rules |
| CN | NDRC, Customs, SAMR, CSRC | ndrc.gov.cn; customs.gov.cn; samr.gov.cn; csrc.gov.cn | Investment/industrial plans; trade data and export licensing; antitrust reviews (e.g. of chip deals); listings |
| CN | Exchanges | hkexnews.hk; sse.com.cn (STAR Market); szse.cn; cninfo.com.cn | IPOs, bonds, material announcements of Chinese AI/chip firms |
| CN | Xinhua / People's Daily | news.cn; people.com.cn | Official readouts; reprints of ministry documents |
| Other | Company IR / newsrooms | e.g. investor.tsmc.com, asml.com/en/news, nvidianews.nvidia.com | Company statements, results, guidance on China revenue. Often block scripts (403): open in a browser and save the text. |

## 4. Topics and entities to scan (prioritised, not exclusive)

Search by **theme**; these entities are where material events most often appear.

| Theme | US | China | Elsewhere |
|---|---|---|---|
| AI accelerators and export controls | NVIDIA, AMD, Intel, Broadcom, Marvell, Qualcomm, Cerebras, Groq | Huawei (Ascend/HiSilicon), Cambricon, Hygon, Moore Threads, MetaX, Biren, Kunlunxin (Baidu), T-Head (Alibaba) | — |
| Manufacturing and equipment | Intel Foundry, Applied Materials, Lam Research, KLA, Synopsys, Cadence (EDA) | SMIC, Hua Hong, Naura, AMEC, SMEE, JCET (packaging) | TSMC, ASML, Tokyo Electron, Samsung, ASM International |
| Memory | Micron | CXMT, YMTC | SK hynix, Samsung |
| Frontier models and compute | OpenAI, Google/DeepMind, Microsoft, Amazon/AWS, Meta, Anthropic, xAI, Oracle, CoreWeave | DeepSeek, Alibaba (Qwen), ByteDance (Doubao), Tencent, Baidu (ERNIE), Zhipu, Moonshot, MiniMax, StepFun, iFlytek | Arm, SoftBank; Gulf data-centre projects (G42, Humain) needing US licences |
| Servers and diversion risk | Super Micro, Dell, HPE | Inspur, Lenovo, Xiaomi (in-house chips) | Foxconn; hubs such as Singapore, Malaysia, Thailand |
| Finance and reputation | US listings, CFIUS, outbound-investment rules | AI/chip IPOs and bonds (HKEX, STAR), state funds ("Big Fund") | — |

Also scan beyond companies: regulators and standards bodies (NIST, TC260), research results, litigation (ITC,
patent and list challenges), rare earths and critical minerals, and data-centre power and infrastructure.

## 5. News outlets: use for discovery and corroboration, not as automatic proof

| Outlet type | Examples | How to treat |
|---|---|---|
| Wire and financial press | Reuters, Bloomberg, Financial Times, WSJ, AP, Nikkei Asia | Strong original reporting; often paywalled or 403 to scripts. Say 据路透社报道 when it is the only source. |
| Greater China | Caixin 财新, SCMP, Yicai 第一财经, 21st Century Business Herald, The Paper 澎湃, Jiemian 界面, CLS 财联社, 36Kr | Good for China-side detail; check who the original source is. |
| Trade and tech | The Information, Semiconductor Engineering, EE Times, DigiTimes, TrendForce, TechCrunch, Tom's Hardware | Technical context; label analysis and estimates as such. |

Distinguish **original reporting** from syndication (an aggregator or "via" page), **opinion/commentary**,
**company press releases** (company_statement, even on a news site) and **search/aggregator links** (never evidence).
A claim is not verified because a major outlet printed it: for legal, list and policy claims, find the official document.

## 6. When a source will not open

1. Try the official API or a listing/print version (Federal Register API; ministry listing pages).
2. Try a reprint by the same body or an official outlet (gov.cn or Xinhua reprinting a ministry document).
3. Open it in a browser, save the visible text to a file and register it: `brief.py fetch RUN URL --file PAGE.txt` (recorded as browser reading).
4. Use a second, independent report and write 据报.
5. Otherwise record the source with `access_status: "blocked"` and an empty quote; the claim stays unverified and the
   report says the original could not be obtained. **A 403 or timeout is never evidence that a claim is false.**
