主代理中途审查纠正，续接同一会话。继续完成第1步，但先修以下违约点，不再扩展设计：
1. C1必须保存实际上游发送的PCM原字节。当前appendSent只发64位自定义digest，前端用C0/候选frame重建C1，这在损坏/缺失时无法回放服务听到的声音，违背contract第3条。请append记录直接含服务端socket.send成功后的实际audio base64（可沿用frame/samples字段做对齐）；UI的C1必须来自这个实际字段而非本地候选。体积每帧约2KB可接受，每次有60s上限。无需自创摘要算法，若不再使用则删除pcmDigest。client frame/source sample range可以继续关联C0，但不能替代C1内容。
2. 独立diag item->turn map必须保留到本次诊断结束。原inputTurns在interrupt被删，rawASR中t会undefined；诊断还要能够把旧ASR关联原turn，不能因此标未知归属，现有正常行为保持不变。map可以放VoiceDiagnosticTrace，item()时建立，asr()时查。
3. 原始ASR和真实转发text必须分开记录。当前diag.asr outcome=forwarded发生在真正emit之前，不能单凭这个字段作为已转发证据。前端收到真实text事件单独记录serverText，再在question DOM赋值后记录displayText，三处独立。
4. 仔细覆盖旧turn返回、socket.send抛错、没有diag-ready确认不发音频、停止/清空/容量上限。不要修改VAD或旧输入过滤的产品语义。
你已完成部分实现，不重启探索，不重做其它文件。把失败原因追加lessons.md。继续写UI/客户端和定点测试/typecheck/build。不要启动浏览器/服务/ASR，不触动其它用户修改。完成后停止，主代理做真实Chrome验收。