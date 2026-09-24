# خطة تجهيز Bee2Bee للـ Production

> المصدر: نسخة من [Chatit-cloud/BEE2BEE](https://github.com/Chatit-cloud/BEE2BEE) (commit `c4dbbb8`، 103 commit، الإصدار `3.7.1` على PyPI).
> تاريخ المراجعة: 2026-09-24.
> حالة الاختبارات وقت المراجعة: `pytest` → **12 نجحوا، 1 فشل** (`tests/test_nat_optional.py`، لأن `try_upnp_map` بقت `async` والاختبار بيناديها كأنها sync).

---

## ✅ حالة التنفيذ (تم تحديثها بعد التنفيذ)

الأرقام دي بتشاور على البنود اللي في §3.

| البند | الحالة | الملاحظة |
|---|---|---|
| 1–9 (P0 bugs) | ✅ اتعمل | الـ protocol اتوحد (v2)، الـ streaming بقى موحد، شلنا `requests` لصالح `httpx`، الـ Dockerfile والـ workflow اتصلحوا، كل الـ blocking I/O بقى في threads |
| 10–11 (Supabase) | ✅ اتعمل | migration جديدة فيها RLS صارمة، والكتابة بقت بالـ service role من الـ gateway بس. عليها اختبارات أوتوماتيك على Postgres |
| 12 (هوية الـ nodes) | ✅ اتعمل | مفاتيح Ed25519، والـ `peer_id` مشتق من المفتاح، وفيه challenge/response في الاتجاهين |
| 13 (SSRF) | ✅ اتعمل | `/connect` بقى POST ومحمي، `?target=` اتشال، والـ DNS بيتفحص لحظة الاتصال |
| 14–18 (API/CORS/TLS/token/limits) | ✅ اتعمل | الـ API مقفول افتراضيًا، CORS بقى allowlist، شلنا الـ downgrade لـ ws، الـ HF token بقى من env، وفيه rate limits وحدود على المدخلات |
| 19–20 | ✅ اتعمل | scrypt بدل sha256، وشلنا الـ metrics المتأليفة |
| 21–29 (Reliability) | ✅ اتعمل | reconnect/backoff، طرد الـ peers الميتة، cancel، failover، hop limit، مطابقة موديلات دقيقة، تنضيف بـ pg_cron، gateway مستقل بدل Vercel، graceful shutdown |
| 30–31 (Tests/CI) | ✅ اتعمل | 91 اختبار Python + 37 للـ gateway (فيهم interop مع Python node حقيقي) + 5 vitest + 6 Playwright E2E + اختبارات RLS، وكلهم في CI |
| 32 (أدوات الجودة) | ✅ اتعمل | ruff + mypy + eslint، و`App.jsx` اتقسم لصفحات ومكونات TypeScript |
| 33–36 | ✅ اتعمل | dependencies متنضفة، الكود الميت اتشال، الأسماء اتوحدت على `BEE2BEE_*`، و`.gitignore` اتصلح |
| 37–43 (Ops) | ✅ اتعمل | JSON logs و`/healthz` `/readyz` `/metrics` وSentry اختياري وconfig validation وDocker/compose وrelease pipeline |
| 44–45 | ✅ اتعمل | تسجيل دخول (magic link/GitHub) و`/v1/chat/completions` على الـ node والـ gateway |
| 46 (Billing) | 🟡 جزئي | فيه quotas شهرية لكل API key وتتبع استهلاك حقيقي، لكن مفيش دفع (Stripe) |
| 47 (Trust) | 🟡 جزئي | فيه reputation مبنية على نجاح وفشل الطلبات، لكن مفيش spot-checking لجودة الإجابات |
| 48 (Privacy) | 🟡 جزئي | تحذير واضح في الواجهة + Privacy/Terms، لكن النصوص **مسودات محتاجة مراجعة قانونية**. التشفير من الطرف للطرف مش ممكن بطبيعة التصميم، وده مكتوب بوضوح |
| 49 (History) | ✅ اتعمل | محفوظ في Supabase وعليه RLS، والمستخدم يقدر يقفله أو يمسحه |

### المتبقي، ومحتاج قرار أو حسابات منك
- **ربط الإنتاج الفعلي:** مشروع Supabase، ودومين الـ gateway، وتعديل `app/vercel.json` للدومين الحقيقي، وإعداد PyPI trusted publishing وبيئة `pypi` على GitHub.
- **Staging + alerting:** قواعد التنبيه مكتوبة في `docs/RUNBOOK.md` لكن محتاجة Prometheus/Grafana أو خدمة مراقبة.
- **Sentry للـ frontend:** أخطاء الواجهة دلوقتي بتتبعت لـ logs الـ gateway، مش لـ Sentry.
- **الـ CI على GitHub:** الـ workflows اتكتبت واتفحصت محليًا (نفس الأوامر نجحت)، لكنها لسه ما اشتغلتش على GitHub Actions.
- **Breaking change:** البروتوكول v2 مش متوافق مع nodes الإصدار 3.x، فكل الـ nodes لازم تتحدث.

---

## 1. المشروع بيتكون من إيه؟

| الجزء | المكان | الوظيفة |
|---|---|---|
| **Python node / CLI** | `bee2bee/` | node من نوع P2P شغال على WebSocket، بيقدّم موديلات (Ollama / HF محلي / HF Inference API)، ومعاه FastAPI sidecar |
| **Gateway (Node.js)** | `app/api/` | Express + `bridge.js`، بيتصل بالـ mesh عن طريق WebSocket وبيعمل proxy لطلبات التوليد بالـ streaming |
| **Frontend** | `app/src/` | React + Vite + Tailwind (صفحة هبوط + dashboard + chat)، مترفوع على Vercel |
| **Registry / DB** | `SUPABASE_SCHEMA.sql` | Supabase: `active_nodes` و`messages` و`profiles` و`node_logs` و view اسمها `system_stats` |
| **Notebooks / scripts** | `notebook/`, `scripts/`, `examples/` | تشغيل node على Colab وسكريبتات debug |

---

## 2. الموجود فعلًا ✅

- **CLI** (`bee2bee serve-ollama | serve-hf | serve-hf-remote | register`)، والحزمة منشورة على PyPI.
- **P2P node**: handshake (`hello`) وتبادل قائمة الـ peers وping/pong بقياس الـ latency وإعلان الخدمات (`service_announce`).
- **3 backends للـ inference**: `HFService` و`OllamaService` و`HFRemoteService`، وفيهم streaming.
- **اختيار provider** على أساس السعر وبعده الـ latency (`pick_provider`).
- **Relay**: الـ node تقدر تحوّل الطلب لـ peer تاني عنده الموديل.
- **NAT traversal**: UPnP ثم STUN، وبعدهم fallback للـ LAN IP.
- **FastAPI**: `/` و`/peers` و`/providers` و`/connect` و`/chat` و`/generate`، وفيه API key اختياري (`X-API-KEY`).
- **Registry** على Supabase بيتعمله sync كل 15 ثانية، وفيه system metrics (CPU/RAM/GPU).
- **Gateway** بيعمل streaming للردود للـ frontend، وبيخزن عدد الـ tokens في Supabase.
- **Frontend** كامل: landing وdashboard وchat بـ Markdown/KaTeX/code highlighting وخريطة للـ mesh.
- **Dockerfile** و`.env.example` وكام ملف توثيق (Deployment وP2P setup وPublishing).
- اختبارات unit أساسية (13 test).

---

## 3. الناقص والمشاكل (مرتبة حسب الأولوية)

### 🔴 P0: Bugs بتكسر الوظيفة الأساسية

1. **التوليد من node لـ node عمره ما بيرجع رد.**
   `_handle_gen_request` بيرد بـ `gen_success` / `gen_chunk` / `gen_error` (`bee2bee/p2p_runtime.py:607-631`)، لكن الـ `handlers` عند الطرف اللي طالب مفيهاش غير `gen_result` (`p2p_runtime.py:460-470`). النتيجة إن `request_generation` بيفضل مستني لحد ما يعمل timeout بعد 300 ثانية.
   وفي العكس: مسار الـ relay بيرجع `gen_result`، والـ gateway (`app/api/bridge.js:181-203`) مش بيفهم غير `gen_success`، فالـ relay كمان بايظ مع الـ gateway.
   → **الحل:** توحيد الـ protocol (§4.1) وعمل handler لكل الأنواع.
2. **الـ streaming مش متسق بين الـ backends.** `HFService.execute_stream` بيطلع JSON lines، و`OllamaService.execute_stream` بيطلع نص خام. `_handle_gen_request` بيعمل `json.loads` لكل chunk وبيبلع الـ exception، فـ **الـ streaming عن طريق P2P لموديلات Ollama بيطلع فاضي**. والـ `/chat?stream=true` بيرجع شكلين مختلفين حسب الـ backend.
3. **`requests` مش موجودة في الـ dependencies**، مع إن `OllamaService` معتمد عليها. أي تثبيت نضيف لـ `pip install bee2bee` هيقع أول ما حد يشغّل `serve-ollama`.
4. **الـ Dockerfile بايظ:** بيشغّل `python -m connectit api ...`، والموديول ده اتشال (اسمه دلوقتي `bee2bee`)، ومفيش أمر اسمه `api` في الـ CLI.
5. **GitHub workflow بايظ:** `.github/workflows/actions.yaml` بيبني `electron-app/`، والفولدر ده مش موجود.
6. **`p2p_runtime.py` لما يتشغل مباشرة** (وده اللي `run.sh` بيعمله) بيستخدم `os.environ` من غير `import os`، فبيقع بـ `NameError` مع `--endpoint`.
7. **الـ Frontend بينادي endpoints مش موجودة:** `/api/subscribe` (`App.jsx:168`) و`/api/v1/*` (`app/src/api/index.js`).
8. **Inference بيعطّل الـ event loop:** `svc.execute()` و`execute_stream()` (وهما sync، HTTP/torch) بيتنادوا جوه `async` handlers، فأي طلب توليد بيوقف الـ pings والـ peers التانيين. لازم يتنقلوا لـ `run_in_executor` / `asyncio.to_thread` أو يتحولوا لـ `httpx.AsyncClient`.
9. **`start()` بتشغل monitoring loop من غير ما تعلّم `_monitor_active`** وبعد كده `enable_monitoring()` بيتنادى، فممكن يشتغل loopين. وفيه `asyncio.create_task` في أماكن كتير من غير ما حد يحتفظ بمرجع للـ task، فالـ garbage collector ممكن يلمّها.

### 🔴 P0: أمان (لازم يتحل قبل أي نشر عام)

10. **Supabase مفتوح لأي حد:** policies جدول `active_nodes` بتسمح بـ `INSERT`/`UPDATE` لأي حد بالـ anon key (`WITH CHECK (true)`). يعني أي حد يقدر يسجّل node مزيفة أو يعدّل `addr` بتاعة node حقيقية ويحوّل الترافيك لسيرفره (hijacking للطلبات والـ prompts).
11. **الـ gateway بيكتب في `messages` بالـ anon key** و`user_id` فاضي، والـ policy بتشترط `auth.uid() = user_id`، فإما الكتابة بتفشل بصمت، وإما هيتضطروا يفتحوا الـ policy. الـ gateway لازم يستخدم **service-role key** على السيرفر بس، ومفتاح التسجيل للـ nodes يبقى منفصل.
12. **الـ P2P protocol مفيهوش أي authentication:** الـ `peer_id` بيعلنه الـ peer عن نفسه ومحدش بيتحقق منه. أي peer يقدر ينتحل peer تاني، أو يعلن موديلات مش عنده، أو يبعت `peer_list` مليانة عناوين تخلي الـ node تفتح اتصالات لأي مكان (SSRF / amplification).
    → **الحل:** مفاتيح Ed25519 لكل node، والـ `peer_id = hash(pubkey)`، والرسائل موقّعة، ومفيش اتصال بعنوان جاي من `peer_list` غير بعد ما يعدّي على allowlist/limits.
13. **SSRF صريح:** `GET /connect?addr=...` في FastAPI، و`?target=` في `/api/p2p/status`، و`discover_peer` في الـ gateway، كلهم بيخلّوا السيرفر يتصل بأي URL.
14. **الـ API مفتوح افتراضيًا:** لو `BEE2BEE_API_KEY` مش متحدد، كل حاجة مفتوحة، و`/chat` متاح للعالم (وده استهلاك مجاني لـ GPU/HF token صاحب الـ node).
    → **الحل:** الافتراضي يبقى مقفول، ويتولّد key عشوائي أول ما الـ node تشتغل.
15. **CORS `*` مع `allow_credentials=True`** في FastAPI، وCORS `*` في الـ WebSocket والـ Express.
16. **مفيش TLS:** كل العناوين `ws://` و`http://`، وفيه **downgrade تلقائي من `wss` لـ `ws`** لو الـ SSL فشل (`p2p_runtime.py:353-361`). ده باب مفتوح لـ MITM، ولازم يتشال.
17. **HF token بيتمرّر كـ CLI argument** (`--token`)، فبيبان في `ps` وفي الـ shell history. الأفضل يتقري من env أو من ملف.
18. **مفيش rate limiting ولا حدود على المدخلات:** `max_new_tokens` ممكن يوصل لأي رقم، والـ prompt من غير حد أقصى، والـ `max_size=32MB` على رسائل الـ WebSocket، ومفيش حد لعدد الـ peers أو للـ pending requests.
19. **`hash_password` = sha256(password+salt):** مش مستخدمة في مسار مهم دلوقتي، لكن لازم تتشال أو تتبدل بـ argon2/bcrypt قبل ما حد يستخدمها.
20. **الـ metrics متأليفة:** `throughput = cpu*0.85` و`trust_score = 0.98 + gpu*0.0001` (`utils.py`). دي أرقام مش حقيقية بتتعرض على إنها قياسات، ولازم تتشال أو تتحسب فعلًا.

### 🟠 P1: الاعتمادية (Reliability)

21. **مفيش reconnect/backoff** للـ bootstrap ولا للـ peers لما الاتصال يقع (بعد ما الاتصال الأول يفشل، الـ node بتفضل معزولة).
22. **مفيش timeout للـ peers الميتة:** الـ health check بيبعت ping بس، ومش بيشيل الـ peer لو مردش. الأصح: لو مفيش `pong` خلال N×interval، الـ peer يتشال.
23. **مفيش إلغاء (cancellation):** لو العميل قفل الـ stream، التوليد بيكمل. ولو الـ provider وقع، الـ future بيستنى 300 ثانية بدل ما يتلغي فورًا في `_on_disconnect`.
24. **مفيش failover:** لو الـ provider اللي اتختار فشل، مفيش retry على اللي بعده.
25. **حلقات الـ relay:** مفيش TTL/hop-count ولا `seen` set، فممكن الطلب يلف بين nodes.
26. **مطابقة الموديلات بالـ substring** (`req.model in m or m in req.model`): طلب `llama` ممكن يروح لـ `llama3:70b`. لازم يبقى فيه اسم موديل canonical.
27. **تنضيف الـ registry:** الـ nodes القديمة مش بتتشال (فيه تعليق بس عن `pg_cron`). المفروض يبقى فيه TTL + job مجدول.
28. **الـ Gateway على Vercel serverless ضد التصميم نفسه:** `bridge.js` بيعتمد على WebSocket دائم و`setInterval`، والـ `DEPLOYMENT.md` نفسه بيقول إن Vercel مش مناسب. الـ gateway لازم يبقى service طويل العمر (Fly.io / Railway / VM / K8s)، وVercel يبقى للـ frontend الـ static بس.
29. **Graceful shutdown:** مفيش signal handling سليم، والـ UPnP mappings مش بتتشال عند الإغلاق.

### 🟠 P1: الجودة والاختبارات

30. **التغطية ضعيفة:** مفيش اختبارات للـ protocol بين nodeين، ولا للـ relay، ولا للـ streaming، ولا للـ gateway، ولا للـ frontend.
31. **مفيش CI:** لا lint ولا type-check ولا tests على PRs.
32. **مفيش أدوات جودة:** مفيش `ruff`/`black`/`mypy` للـ Python، والـ ESLint موجود لكن مش بيتشغل، و`App.jsx` حجمه 1191 سطر في ملف واحد.
33. **Dependencies:** مفيش lockfile للـ Python، و`numpy` ومكتبات تانية مفروضة على الكل من غير ما يكون فيه احتياج. `typer` و`click` الاتنين موجودين، والمستخدم واحد بس.
34. **كود ميت أو ناقص:** `_handle_piece_request` و`_handle_piece_data` فاضيين، و`dht.py` و`model.py` و`datasets.py` و`services` قديمة، و`App.tsx.bak` و`App.css.bak` و`README.md.backup`، و`bee2bee.egg-info/` متعمله commit، و`notebook/ConnectIT_Cloud_Node-BORE.ipynb` حوالي 35 ألف سطر.
35. **أسماء قديمة متلخبطة:** `connectit` و`coithub` و`bee2bee` مستخدمين مع بعض في الكود والـ env vars (`CONNECTIT_*` و`BEE2BEE_*` و`VITE_SUPABASE_*` في الـ backend).
36. **`.gitignore` بيتجاهل `*.ts`**، وده ممكن يخفي ملفات TypeScript من الـ frontend.

### 🟡 P2: التشغيل والمراقبة (Observability & Ops)

37. **Logging:** `bee2bee.log` بيتكتب في الـ cwd، واللوج خليط بين `rich` و`loguru` و`print`. محتاجين structured JSON logs وrequest ID لكل طلب.
38. **مفيش `/healthz` و`/readyz`** للـ node وللـ gateway (عشان Docker/K8s health checks).
39. **مفيش Prometheus metrics** (عدد الطلبات، الـ latency p50/p95، الأخطاء، عدد الـ peers، الـ tokens/sec الحقيقي).
40. **مفيش error tracking** (Sentry أو ما يشبهه) في الـ frontend والـ gateway.
41. **Config:** مفيش validation (مثلًا بـ pydantic-settings)، والـ default `bootstrap_url = ws://127.0.0.1:4003`، وده مش منطقي لمستخدم جديد.
42. **Docker:** مفيش multi-stage، وشغال بـ root، ومفيش `HEALTHCHECK` ولا `.dockerignore`، ومفيش `docker-compose` للبيئة كلها (node + gateway + frontend + Supabase local).
43. **Versioning/Release:** مفيش CHANGELOG ولا semantic-release، والـ publish على PyPI يدوي.

### 🟡 P2: المنتج

44. **Auth للمستخدمين:** جدول `profiles` موجود لكن مفيش login فعلي في الـ UI، والـ chat كله anonymous.
45. **API عام متوافق مع OpenAI** (`/v1/chat/completions`) مع API keys للمستخدمين: ده أسهل طريق لتبني المنصة من المطورين.
46. **Billing/Quotas:** `price_per_token` بيتعلن لكن مفيش محاسبة ولا حدود استخدام لكل مستخدم.
47. **Trust / Verification للـ providers:** مفيش أي طريقة تتأكد إن الـ node بترجع مخرجات الموديل اللي بتقول عليه فعلًا. ممكن نبدأ بـ spot-check (prompts معروفة إجاباتها) وسمعة (reputation) مبنية على نجاح الطلبات.
48. **Privacy:** الـ prompts بتعدّي على nodes مجهولة من غير تشفير. لازم يبقى فيه على الأقل تحذير واضح للمستخدم + Terms of Service + Privacy Policy.
49. **Chat history:** مفيش حفظ للمحادثات لكل مستخدم.

---

## 4. خطة التنفيذ

### المرحلة 0: تنظيف وإصلاح الأساس (أسبوع تقريبًا)
- [ ] إصلاح الـ P0 bugs من #1 لـ #9.
- [ ] **4.1 توحيد الـ protocol:** ملف `bee2bee/protocol.py` فيه كل الـ message types (`hello` و`peer_list` و`ping` و`pong` و`service_announce` و`gen_request` و`gen_chunk` و`gen_done` و`gen_error`)، معرّفة بـ pydantic models + `protocol_version` في الـ `hello`، ونفس الـ spec مكتوب في `docs/PROTOCOL.md` ومطبّق في `bridge.js`.
- [ ] كل الـ backends يرجعوا نفس شكل الـ stream (`{"text": ...}` ثم `{"done": true, "usage": ...}`).
- [ ] إضافة `requests` أو (أحسن) نقل الكل لـ `httpx`.
- [ ] مسح الملفات الميتة والـ backups والـ `egg-info`، وتوحيد الأسماء على `BEE2BEE_*`.
- [ ] إصلاح الاختبار الفاشل.

### المرحلة 1: الأمان (أسبوع أو اتنين)
- [ ] إعادة كتابة Supabase RLS: الـ anon يقرا بس، والكتابة في `active_nodes` تبقى عن طريق Edge Function / gateway بتتحقق من توقيع الـ node.
- [ ] هوية للـ nodes بمفاتيح Ed25519 + رسائل موقّعة + `peer_id` مشتق من المفتاح.
- [ ] الـ API مقفول افتراضيًا، وCORS بـ allowlist، وrate limiting (`slowapi` في FastAPI و`express-rate-limit` في الـ gateway)، وحدود على `max_new_tokens` والـ prompt وحجم الرسائل.
- [ ] إزالة الـ SSRF: validation للـ URLs، ومنع الـ private IP ranges في الـ gateway، وقفل `/connect` أو حمايته بـ admin key.
- [ ] TLS: `wss://` إلزامي في production، وشيل الـ downgrade، وreverse proxy (Caddy/Traefik) قدام الـ gateway.
- [ ] نقل الأسرار: `service_role` على السيرفر بس، و`--token` يتشال لصالح `HF_TOKEN` من env.
- [ ] `pip-audit` و`npm audit` وsecret scanning في الـ CI.

### المرحلة 2: الاعتمادية والتشغيل (أسبوعين)
- [ ] reconnect بـ exponential backoff، وطرد الـ peers الميتة، وcancellation للطلبات، وfailover لـ provider تاني.
- [ ] TTL/hop-limit للـ relay، وأسماء موديلات canonical.
- [ ] كل الـ I/O الـ blocking يتنقل لـ thread pool أو async client.
- [ ] نقل الـ gateway من Vercel لـ Fly.io أو Railway كـ long-running service. Vercel للـ static frontend بس.
- [ ] `/healthz` و`/readyz` و`/metrics` (Prometheus)، وstructured logs، وSentry.
- [ ] Dockerfile جديد (multi-stage، non-root، HEALTHCHECK) + `docker-compose.yml` للبيئة المحلية كاملة.
- [ ] `pg_cron` لتنضيف الـ nodes القديمة + migrations بـ Supabase CLI بدل ملف SQL واحد.

### المرحلة 3: الجودة والـ CI/CD (بالتوازي مع المراحل اللي فاتت)
- [ ] GitHub Actions: `ruff` + `mypy` + `pytest` (Python 3.10–3.12)، و`eslint` + `tsc` + `vite build` للـ frontend.
- [ ] Integration tests: nodeين حقيقيين + mock backend، يغطوا الـ handshake والتوليد والـ streaming والـ relay والـ disconnect.
- [ ] Tests للـ gateway (`supertest`) وE2E للـ frontend (Playwright).
- [ ] تقسيم `App.jsx` لـ components + pages، والانتقال الكامل لـ TypeScript.
- [ ] Release pipeline: tag → build → publish على PyPI بـ trusted publishing + Docker image على GHCR + CHANGELOG.

### المرحلة 4: جاهزية المنتج
- [ ] Auth للمستخدمين (Supabase Auth) + API keys لكل مستخدم + quotas.
- [ ] Endpoint متوافق مع OpenAI `/v1/chat/completions`.
- [ ] Reputation / spot-checking للـ providers + حساب الـ tokens بالـ tokenizer الحقيقي.
- [ ] Terms / Privacy / تحذير الخصوصية في الـ UI.
- [ ] توثيق: Architecture diagram، وProtocol spec، وRunbook للتشغيل، وSECURITY.md.

---

## 5. تعريف "Production Ready" (معايير القبول)

- [ ] CI أخضر على كل PR (lint + types + unit + integration).
- [ ] مفيش endpoint يقدر يكتب في الـ DB أو يتصل بعناوين خارجية من غير تحقق.
- [ ] كل الاتصالات العامة شغالة على TLS.
- [ ] طلب توليد عن طريق الـ gateway ← node ← relay ← node بيرجع بنجاح في integration test.
- [ ] الـ node بترجع اتصالها تلقائيًا بعد ما الـ bootstrap يقع ويرجع.
- [ ] Health checks + metrics + alerting شغالين على بيئة staging.
- [ ] Load test (مثلًا `k6`) بيوضّح حدود النظام الفعلية (عدد الطلبات المتزامنة لكل node وللـ gateway).
- [ ] Docker image رسمي بيشتغل بأمر واحد، و`pip install bee2bee` النضيف بيشتغل مع كل الـ backends المعلن عنها.
