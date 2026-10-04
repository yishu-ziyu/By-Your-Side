/** 页面读数的取值与脱敏：结果账本的读前读后对比用。 */
import { redactCredentialText } from '../../shared/untrusted.js';

/** Empty text is a real read; non-form elements must not prefer a stray value property. */
export function elementText(data:Record<string,unknown>):string|undefined {
  if(typeof data.editableText==='string')return data.editableText;
  const properties=data.properties&&typeof data.properties==='object'?data.properties as Record<string,unknown>:{};
  const form=typeof data.tagName!=='string'||['input','textarea','select','option'].includes(data.tagName.toLowerCase());
  const values=form?[data.value,properties.value,data.textContent,properties.textContent]:[data.textContent,properties.textContent,data.value,properties.value];

  return values.find((value):value is string=>typeof value==='string');
}

/** Retain original whitespace; the generic display redactor also folds blank lines. */
export function redactObservedText(text:string):{text:string;redacted:boolean} {
  const masked=redactCredentialText(text);
  const redacted=masked.split('[redacted]').length>text.split('[redacted]').length;

  return {text:redacted?masked:text,redacted};
}
