import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { launchRealPath, requireHeadless, until } from "./harness.mts";

requireHeadless();
const dist = process.env.SIDEAGENT_ACCEPTANCE_DIST ?? fileURLToPath(new URL("../../../extension/dist", import.meta.url));
const rp = await launchRealPath({dist});
const failures: Error[] = [];
const OLD = "用简短、平实的措辞。";
const NEW = "改用第一人称，保留引号和换行。";
try {
  for (const c of [
    {name:"persona", nav:"voice", key:"voice_persona", list:"#persona-list", text:"#persona-text", save:"#persona-save", status:"#persona-status", blur:true},
    {name:"translation", nav:"web", key:"translation_style", list:"#translation-style-list", text:"#translation-style-text", save:"#translation-style-save", status:"#translation-status", blur:false},
  ]) {
    const { targetId } = await rp.cdp.send("Target.createTarget", { url: `chrome-extension://${rp.extensionId}/settings.html#${c.nav}` });
    const page = await rp.attach(targetId);
    try {
      await until(async()=>await rp.evaluate(page,`document.querySelector(${JSON.stringify(c.list)})?.lastElementChild?.querySelector("button")?.checkVisibility() || false`),15000,"设置项可见");
      // Block only the selected write in this fresh test profile. Release executes the native API.
      await rp.evaluate(page,`(() => {
        const key=${JSON.stringify(c.key)};
        const storage=chrome.storage.local;
        const set=storage.set.bind(storage);
        storage.set=(items,...args)=>{
          if(!Object.hasOwn(items,key)) return set(items,...args);
          return new Promise((resolve,reject)=>{
            window.releaseControlledSave=()=>{
              delete window.releaseControlledSave;
              return set(items,...args).then(resolve,reject);
            };
          });
        };
        return true;
      })()`);
      const click = async (selector: string) => {
        await rp.evaluate(page,`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:"center"})`);
        await rp.click(page,selector);
      };
      const fill = async (value: string) => {
        await click(c.text);
        await rp.evaluate(page,`document.querySelector(${JSON.stringify(c.text)}).select()`);
        await rp.typeText(page,value);
        assert.equal(await rp.evaluate(page,`document.querySelector(${JSON.stringify(c.text)}).value`),value);
      };
      const probe = () => rp.evaluate(page,`(() => {
        const input=document.querySelector(${JSON.stringify(c.text)});
        const event=new Event("beforeunload",{cancelable:true});
        window.dispatchEvent(event);
        return { draft:input.value, focused:document.activeElement===input, warns:event.defaultPrevented, status:document.querySelector(${JSON.stringify(c.status)}).textContent };
      })()`) as Promise<{draft:string;focused:boolean;warns:boolean;status:string}>;
      await click(c.list+" > :last-child button");
      await fill(OLD);
      await click(c.save);
      await until(async()=>await rp.evaluate(page,"typeof window.releaseControlledSave === 'function'"),5000,"第一版保存等待中");
      await fill(NEW);
      const before=await probe();
      assert.equal(before.warns,true);
      if(c.blur) await rp.evaluate(page,`document.querySelector(${JSON.stringify(c.text)}).blur()`);
      const readStored = () => rp.evaluate(page,`chrome.storage.local.get(${JSON.stringify(c.key)}).then(v=>v[${JSON.stringify(c.key)}]?.text)`);
      await rp.evaluate(page,"window.releaseControlledSave()");
      await until(async()=> (await readStored()) === OLD,5000,"第一版已写入持久存储");
      const after = await probe();
      assert.equal(await readStored(), OLD, "这次只提交了当时捕获的第一版");
      assert.deepEqual({draft:after.draft,warns:after.warns}, {draft:NEW,warns:true}, "第一版回执必须保留新草稿和未保存提醒");

      await click(c.save);
      await until(async()=>await rp.evaluate(page,"typeof window.releaseControlledSave === 'function'"),5000,"第二版保存等待中");
      await rp.evaluate(page,"window.releaseControlledSave()");
      await until(async()=> (await readStored())===NEW && !(await probe()).warns,5000,"第二版确实保存，才清除未保存提醒");
      console.log(`PASS ${c.name}`);
    } catch (error) {
      const failure = new Error(`${c.name}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      failures.push(failure);
      console.error(failure.message);
    } finally {
      await rp.cdp.send("Target.closeTarget",{targetId});
    }
  }
} finally {
  await rp.close();
  await rp.remove();
}
if (failures.length) throw new AggregateError(failures, "设置草稿验收失败");
