import type {ExtensionFactory} from '@earendil-works/pi-coding-agent';

/**
 * 找不到目标时的探索阶梯。
 *
 * 一次任务里数「死路」：没找到目标的报错，和打开后没用上就关掉的菜单。绕路的大头是后者：点开菜单本身是成功的，
 * 只是里面没有要的东西，模型按 Esc 或去开下一个，报错计数看不见它。在打开的菜单里点了别的东西算用上了；
 * 成功的输入（填写、打字、选择）说明找到了路，清零。死路到了门槛，就在这条工具结果后面写明下一步：
 * 换做法 → 查官方帮助 → 问用户。找的是付款、删除、发送类的目标时，不自己换着法子试，直接问用户。
 *
 * 死路不一定数得出来（菜单靠点里面的项关上、用 js 翻页面结构），模型常在阶梯没走完时就交「没能做到」。
 * 所以翻过几个菜单后第一次交半成品时先不发给用户，退回去附上阶梯：用户不该先看到放弃、再看到它接着做成。
 */
const LADDER_STEPS = [3, 5, 7] as const;

const NOT_FOUND = /未找到目标|未找到元素|无法获取元素位置|无法确认目标位置|下拉框没有匹配选项/;
/** 点击后页面的反应（shared/effect.ts 的写法）：展开了，或顶层多了弹层。 */
const OPENED = /expanded [^;\n]*→ true|page top level \+\d+ element/;
const EXPANDED = /expanded [^;\n]*→ true/;
const PROBES = new Set(['click', 'double_click']);
const INPUTS = new Set(['fill', 'type_text', 'select_option', 'upload_file']);
const PROGRAM_INPUT = /\.(fill|type_?[tT]ext|select_?[oO]ption|upload_?[fF]ile)\(/;
const RISKY = /付款|支付|付钱|购买|下单|结账|转账|删除(?!线)|删掉|发送|寄出|\b(pay|payment|checkout|purchase|buy now|delete|trash|send)\b/i;

/** 翻过这么多个菜单，才把「交半成品」当作放弃得太早。 */
const GIVE_UP_AFTER_MENUS = 2;

const VISIBLE_SOURCE = 'If the page already shows a concrete 原文, PDF, publisher or source link for what the user asked, click that link now. Do not search the same title or call a JSON API first.';
const ANOTHER_WAY = 'Try another way: syntax typed into the content itself (#tag, @mention, /command, Markdown), a keyboard shortcut, or the right-click menu.';
const HELP = "Read this site's official help without touching the user's page: in browser_run, const r = await browser.fetch({url: <its help or docs page>}); strip the HTML tags in the program and return only the lines about this feature. Then do it the documented way.";
const ASK = 'Stop and ask the user in one short message: what you looked for and where, and the exact way you plan to do it, so they only have to reply 可以.';

function ladderHint(deadEnds:number, risky:boolean):string {
  if(risky)return `[Next step] This step pays, deletes or sends something: do not try other ways to do it yourself. ${ASK}`;

  if(deadEnds>=LADDER_STEPS[2])return `[Next step] ${deadEnds} places tried. ${ASK}`;

  if(deadEnds>=LADDER_STEPS[1])return `[Next step] ${deadEnds} places tried. ${HELP}`;

  if(deadEnds>=LADDER_STEPS[0])return `[Next step] ${deadEnds} places tried without the control. Stop opening more menus; the site may not have one. ${ANOTHER_WAY}`;

  return `[Next step] Not here. ${VISIBLE_SOURCE} Then read the whole page (scroll, hover to reveal, expand collapsed parts), then open at most the two or three most likely menus.`;
}

/** 只看工具自己写的第一行：后面跟着页面快照和新出现的页面文字，是不可信数据，不能让网页替模型数死路或冒充付款。 */
function ownLine(text:string):string {
  return text.split('\n', 1)[0]!.slice(0, 300);
}

export class ExploreLadderPolicy {
  private deadEnds=0;
  /** 打开着、还没用上的菜单：记下打开它时模型写的意图。 */
  private openMenu:string|null=null;
  private menusOpened=0;
  /** 已经退回过一次半成品，或已经叫它去问用户：之后的半成品照常发。 */
  private heldGiveUp=false;

  reset():void {this.deadEnds=0;this.openMenu=null;this.menusOpened=0;this.heldGiveUp=false;}

  extension():ExtensionFactory {
    return pi=>{
      pi.on('tool_call',event=>{
        if(event.toolName!=='send_user_message'||event.input.outcome!=='partial'||this.heldGiveUp)return;

        if(this.menusOpened<GIVE_UP_AFTER_MENUS||this.deadEnds>=LADDER_STEPS[2])return;
        this.heldGiveUp=true;

        // 数的是展开过的菜单，用上的也算，所以会拦到与控件无关的半成品：话里让它原样再发，只多一轮。
        return {block:true, reason:`[Next step] Not delivered: the user has not seen this. If what is missing is something you could not find on the page (${this.menusOpened} menus opened so far), the site may not have it. ${ANOTHER_WAY} If that fails: ${HELP} Only if that fails too: ${ASK} If the blocker is something else (login, captcha, a confirmation only the user can give, data that does not exist), send the same message again.`};
      });
      pi.on('tool_result',event=>{
        if(event.parentToolCallId)return;
        const line=ownLine(event.content.filter(item=>item.type==='text').map(item=>item.text).join('\n'));
        const code=event.toolName==='browser_run'?String(event.input.code??''):'';
        const intent=`${String(event.input.label??'')} ${String(event.input.target??'')}`;

        if(!event.isError&&(INPUTS.has(event.toolName)||PROGRAM_INPUT.test(code))){this.reset();

return;}

        const notFound=event.isError&&NOT_FOUND.test(line);
        const opened=!event.isError&&PROBES.has(event.toolName)&&OPENED.test(line);
        const dismissed=event.toolName==='press_key'&&/^esc(ape)?$/i.test(String(event.input.key??''));
        // 菜单开着时：按 Esc 或又开了一个，前一个就是死路；在里面成功点了别的，算用上了。
        const abandoned=this.openMenu!==null&&(dismissed||opened)?this.openMenu:null;

        if(this.openMenu!==null&&(abandoned!==null||(!event.isError&&PROBES.has(event.toolName))))this.openMenu=null;

        if(opened)this.openMenu=intent;

        if(opened&&EXPANDED.test(line))this.menusOpened+=1;

        if(!notFound&&abandoned===null)return;
        const before=this.deadEnds;
        this.deadEnds+=1;
        const crossed=LADDER_STEPS.some(step=>before<step&&this.deadEnds>=step);

        // 报错每次都带下一步；关掉的菜单只在跨过门槛时带，免得正常翻菜单的任务被打扰。
        if(!notFound&&!crossed)return;
        const risky=RISKY.test(notFound?`${intent} ${line}`:abandoned!);

        if(risky)this.heldGiveUp=true;

        return {content:[...event.content, {type:'text' as const, text:`\n${ladderHint(this.deadEnds, risky)}`}]};
      });
    };
  }
}
