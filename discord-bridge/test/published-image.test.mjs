import test from 'node:test';
import assert from 'node:assert/strict';
import {isPublishedImageCopy} from '../src/published-image.mjs';

test('only this exact tool result with all durable attachments can be reused',()=>{
  const identity={botId:'bot',threadId:'task',turnId:'turn',itemId:'image'};
  const message={author:{id:'bot'},embeds:[{fields:[
    {name:'Task',value:'`task`'},{name:'Turn',value:'`turn`'},{name:'Item',value:'`image`'},
  ]}],attachments:new Map([['file',{name:'result.png',size:20}]])};
  const recorded={attachments:[{name:'result.png',size:20}]};
  assert.equal(isPublishedImageCopy(message,recorded,identity),true);
  assert.equal(isPublishedImageCopy({...message,author:{id:'other'}},recorded,identity),false);
  assert.equal(isPublishedImageCopy(message,recorded,{...identity,turnId:'another'}),false);
  assert.equal(isPublishedImageCopy(message,{attachments:[{name:'result.png',size:21}]},identity),false);
  assert.equal(isPublishedImageCopy({...message,attachments:new Map()},recorded,identity),false);
  assert.equal(isPublishedImageCopy(message,{attachments:[]},identity),false);
});
