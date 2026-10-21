import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { ChannelType } from 'discord.js';
import { DiscordController } from '../src/discord-controller.mjs';
import { StateStore } from '../src/state-store.mjs';

test('repeated mirror sync cannot allocate categories for a fenced task create', {timeout:5000}, async context => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'fenced-sync-'));
  const desktop=path.join(directory,'desktop.json'); fs.writeFileSync(desktop,'{}');
  const store=new StateStore(directory,'123456789');
  const client=new EventEmitter(),codex=new EventEmitter();
  client.user={id:'bot'}; codex.connected=true;
  codex.listAllProjects=async()=>[];
  codex.listAllThreads=async({archived})=>archived ? [{id:'thread-001',cwd:'C:\\work',status:{type:'notLoaded'}}] : [];
  const channels=new Map(); channels.find=predicate=>[...channels.values()].find(predicate);
  let creates=0;
  const category={id:'987654321',name:'Archive',type:ChannelType.GuildCategory,children:{cache:new Map(Array.from({length:50},(_,i)=>[String(i),{}]))}};
  channels.set(category.id,category);
  store.setInfrastructure({archiveCategoryIds:[category.id],controlChannelId:'control'});
  const guild={channels:{fetch:async()=>channels,create:async()=>{creates++;throw new Error('Unexpected Discord write');}}};
  const controlMessages=new Map();
  const control={id:'control',messages:{fetch:async()=>controlMessages},send:async payload=>{
    const message={id:'panel',author:client.user,content:payload.content??'',embeds:payload.embeds??[],components:payload.components??[],
      edit:async next=>Object.assign(message,next)};
    controlMessages.set(message.id,message); return message;
  }};
  client.channels={fetch:async id=>channels.get(id)};
  const controller=new DiscordController({client,codex,stateStore:store,logDir:directory,
    config:{guildId:'123456789',authorizedUserIds:['operator'],desktopGlobalStatePath:desktop,archiveCategoryName:'Archive',projectCategoryPrefix:'Codex - '}});
  controller.infrastructureReady=Promise.resolve({guild,control,completions:{},controlCategory:{id:'control-category'}});
  controller.channelCreateJournal.importUnknown({threadId:'thread-001',guildId:'123456789',categoryId:category.id},{oldBridgePid:1});
  controller.attach();
  context.after(async()=>{await controller.stop();fs.rmSync(directory,{recursive:true,force:true});});
  for(let run=0;run<2;run++) {
    const done=Promise.withResolvers();
    client.emit('interactionCreate',{guildId:'123456789',channelId:'control',user:{id:'operator'},customId:'cx:ui:control:sync',
      deferred:false,replied:false,
      isAutocomplete:()=>false,isChatInputCommand:()=>false,isStringSelectMenu:()=>false,isButton:()=>true,isModalSubmit:()=>false,isRepliable:()=>true,
      deferReply:async function(){this.deferred=true;},editReply:async result=>done.resolve(result),reply:async result=>done.resolve(result)});
    const response=await done.promise;
    assert.equal(controller.taskSyncStatus().phase,'completed',JSON.stringify(response));
  }
  assert.equal(creates,0);
  assert.equal(store.binding('thread-001'),null);
  assert.equal(controller.channelCreateJournal.read('thread-001').phase,'unknown');
  const events=fs.readdirSync(directory).filter(name=>name.startsWith('discord-') && name.endsWith('.jsonl'))
    .flatMap(name=>fs.readFileSync(path.join(directory,name),'utf8').trim().split('\n').map(JSON.parse));
  assert.ok(events.some(event=>event.event==='task-sync-thread-error'
    && event.threadId==='thread-001' && event.error.includes('CHANNEL_CREATE_RESULT_UNRESOLVED')));
});
