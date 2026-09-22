import {expect,it,vi} from 'vitest';
import {replaceEditableText} from '../src/shared/editable-text.js';

function fixture(accepted=true){
  const range={selectNodeContents:vi.fn()};
  const selection={removeAllRanges:vi.fn(),addRange:vi.fn()};
  const document={getSelection:()=>selection,createRange:()=>range,execCommand:vi.fn(()=>accepted)};
  const element={ownerDocument:document,focus:vi.fn(),isConnected:true};

  return {element,document,selection,range};
}

it('serializes without closures and replaces the full multiline value in one editing command',()=>{
  const f=fixture(),value='Exact first sentence.\nhttps://source.test/';
  const injected=Function(`return (${replaceEditableText.toString()})`)() as typeof replaceEditableText;
  injected(f.element as unknown as HTMLElement,value);
  expect(f.range.selectNodeContents).toHaveBeenCalledWith(f.element);
  expect(f.selection.addRange).toHaveBeenCalledWith(f.range);
  expect(f.document.execCommand).toHaveBeenCalledExactlyOnceWith('insertText',false,value);
});

it('does not try another mutation after the editing command fails',()=>{
  const f=fixture(false);
  expect(()=>replaceEditableText(f.element as unknown as HTMLElement,'replacement')).toThrow('先读回');
  expect(f.document.execCommand).toHaveBeenCalledTimes(1);
});

it('does not edit a field detached by focusing',()=>{
  const f=fixture();f.element.focus.mockImplementation(()=>{f.element.isConnected=false;});
  expect(()=>replaceEditableText(f.element as unknown as HTMLElement,'replacement')).toThrow('已失效');
  expect(f.document.execCommand).not.toHaveBeenCalled();
});
