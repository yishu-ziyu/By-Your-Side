# ego-job-apply — 自测 criteria (written before the run)

Claim (EGO, competitor-examples.md): "Search job boards by role/location/work type, open the careers page, fill the full application from your resume PDF, and stop one click before submit"

Fixture: http://127.0.0.1:8995/job/board (server replicate/_fx/server.mjs, port 8995; state /__state?s=<path prefix>)

Prompt to BYS:
> 帮我在这个招聘网站找上海的全职前端工程师岗位，打开它的招聘页，用我电脑上的简历 ~/Documents/resume.pdf 把申请表全部填好（包括上传简历），停在提交前，不要提交。

Pass criterion / expected:
Correct job: Nimbus (Frontend, Shanghai, Full-time); distractors Beijing FT, Shanghai Contract, Backend, Intern. Application fields come from a resume PDF the agent must read and upload; Submit not clicked. Expected 卡在缺能力 (read local PDF + file upload) unless BYS can do it.

Result must be exactly one of 通过 / 失败 / 卡在缺能力 (name capability). Scored from server state + final page DOM, not BYS's receipt. Build: main @ ba3d11a8cc635cf84e850130fa2002fadeaf4a02. One recorded run.
