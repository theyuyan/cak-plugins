# front-plain（前端插件）
零依赖的极简"日志流"前端：一件事一行、审批 y/n/s。它不含内核，只连 daemon 的控制面（`~/.cak/daemon/<session>.json`）。
安装：`cak add front-plain --registry <cak-registry>`（前端没有契约，不跑 conformance，拉代码即装）；切换：`cak front front-plain --session NAME`；设为默认：`cak front --default front-plain`。
写你自己的前端就照这个文件抄：一个 SSE 订阅 + 一个 JSON-RPC 调用。
