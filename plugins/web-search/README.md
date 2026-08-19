# web-search（web.search@1）

网页搜索：Brave / Tavily / 自建 SearXNG 三选一，key 放文件不经模型。配置 `~/.cak/web-search.json`：
```json
{ "engine": "brave",   "keyFile": "~/.cak/secrets/brave.key" }
{ "engine": "tavily",  "keyFile": "~/.cak/secrets/tavily.key" }
{ "engine": "searxng", "url": "http://127.0.0.1:8080" }
```
**诚实**：三种适配器按各家官方响应格式写，用本地假服务器测过（`npm test`）；作者没有 key，**未联网真测**。未配置时返回明确的 `CAPABILITY_ERROR: 未配置`（conformance 可过——它验协议不验搜索）。第一个拿真 key 跑通的人请提 issue 把这行删掉。
