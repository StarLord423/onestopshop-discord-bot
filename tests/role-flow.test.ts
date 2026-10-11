import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, Collection, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { openDatabase, migrate } from '../src/db.js';
import { RoleRequests, ROLE_OPTIONS, ROLE_MENU_CHANNEL, ROLE_APPROVAL_CHANNEL } from '../src/role-requests.js';

test('staff-approved role flow validates identity, permissions, hierarchy and the final role receipt', async t => {
  const db = await openDatabase();
  try {
    await migrate(db,'guild');
    let nextId=0, roleAdds=0, confirmGrant=true, actorAllowed=true, wrongHierarchy=false;
    let partialFetches=0;
    const rolePermissions = new PermissionsBitField();
    const all = new PermissionsBitField(PermissionsBitField.All);
    const none = new PermissionsBitField();
    const cards = new Map<string,any>();
    const dms: string[]=[];
    const requested = ROLE_OPTIONS[4];
    const target = { id:'member',user:{bot:false},pending:false,
      roles:{cache:new Map([['existing-role',{}]]),add:async (role:any) => {
        roleAdds++; if (confirmGrant) target.roles.cache.set(role.id,role); return target;
      }} };
    const actor = {permissions:{has:()=>actorAllowed},roles:{cache:new Map()}};
    const me = {id:'bot',permissions:all,roles:{highest:{id:'bot-role'}}};
    const roles = new Map<string,any>(ROLE_OPTIONS.map(option=>[option.id,{
      ...option,managed:false,permissions:rolePermissions,comparePositionTo:()=>wrongHierarchy ? 1 : -1,
    }]));
    const makeChannel = (id:string) => ({id,type:ChannelType.GuildText,
      permissionsFor:(who:any)=>id===ROLE_MENU_CHANNEL || who.id==='bot' ? all : none,
      messages:{fetch:async (id:string)=>{if (!cards.has(id)) throw {code:10008}; return cards.get(id);}},
      send:async (payload:any)=>{
        const message:any={id:String(++nextId),author:{id:'bot'},embeds:payload.embeds.map((e:any)=>e.toJSON()),
          reactions:{cache:new Collection()},edit:async (data:any)=>{message.embeds=data.embeds.map((e:any)=>e.toJSON());},
          react:async (emoji:string)=>message.reactions.cache.set(emoji,{emoji:{name:emoji},me:true})};
        cards.set(message.id,message);return message;
      }});
    const menu=makeChannel(ROLE_MENU_CHANNEL), staff=makeChannel(ROLE_APPROVAL_CHANNEL);
    const guild:any={id:'guild',ownerId:'owner',
      channels:{fetch:async (id:string)=>id===ROLE_MENU_CHANNEL?menu:staff},
      members:{fetchMe:async()=>me,fetch:async ({user,force}:any)=>{
        assert.equal(force,true); return user==='actor'?actor:target;
      }},roles:{everyone:{id:'everyone'},fetch:async(id:string)=>roles.get(id)}};
    const client:any={user:{id:'bot'},users:{fetch:async()=>({send:async(data:any)=>{dms.push(data.content);}})}};
    let tail=Promise.resolve();
    const serialize=(fn:()=>Promise<void>)=>{const result=tail.then(fn);tail=result.catch(()=>{});return result;};
    const service=new RoleRequests(client,guild,db,serialize);
    await service.maintain();
    const panel=(await db.query("SELECT value FROM settings WHERE key='role_panel_message_id'")).rows[0]!.value;
    const reaction=(emoji=requested.emoji,channel=ROLE_MENU_CHANNEL):any=>({partial:false,
      message:{guildId:'guild',channelId:channel,id:panel,partial:false},emoji:{name:emoji},
      fetch:async()=>{partialFetches++;throw new Error('Should not fetch unrelated reactions');}});
    const rows=async()=> (await db.query('SELECT * FROM role_requests ORDER BY requested_at')).rows;
    let replies:string[]=[];
    const decide=async(action:string,r:any,messageId=r.staff_message_id)=>{
      replies=[];
      await service.onButton({customId:`role:${action}:${r.id}`,guildId:'guild',channelId:ROLE_APPROVAL_CHANNEL,
        user:{id:'actor'},message:{id:messageId,author:{id:'bot'}},
        deferReply:async()=>{},editReply:async(text:string)=>{replies.push(text);}} as any);
    };

    await t.test('menu has exactly five reactions; unrelated partials, unknown emoji and screened members are ignored',async()=>{
      assert.equal(cards.get(panel).reactions.cache.size,5);
      await service.onReaction({...reaction(requested.emoji,'other'),partial:true},{id:'member',bot:false} as any);
      assert.equal(partialFetches,0);
      await service.onReaction(reaction('❌' as any),{id:'member',bot:false} as any);
      target.pending=true;
      await service.onReaction(reaction(),{id:'member',bot:false} as any);
      target.pending=false;
      assert.equal((await rows()).length,0);
    });
    await t.test('duplicate reactions create one pending request and no automatic grant',async()=>{
      await Promise.all([service.onReaction(reaction(),{id:'member',bot:false} as any),service.onReaction(reaction(),{id:'member',bot:false} as any)]);
      assert.equal((await rows()).length,1);assert.equal(roleAdds,0);
      assert.equal(dms.length,1);
    });
    const request=(await rows())[0]!;
    await t.test('unauthorized actors and mismatched staff messages cannot approve',async()=>{
      actorAllowed=false;await decide('approve',request);assert.match(replies[0]!,/authorized staff/);
      actorAllowed=true;await decide('approve',request,'forged');assert.match(replies[0]!,/saved staff review/);
      assert.equal(roleAdds,0);
    });
    await t.test('elevated target roles and hierarchy changes fail closed',async()=>{
      rolePermissions.add(PermissionFlagsBits.ManageRoles);await decide('approve',request);
      assert.match(replies[0]!,/staff permissions/);rolePermissions.remove(PermissionFlagsBits.ManageRoles);
      wrongHierarchy=true;await decide('approve',request);assert.match(replies[0]!,/above/);wrongHierarchy=false;
      assert.equal(roleAdds,0);
    });
    await t.test('a dispatched role add without a fresh receipt remains pending',async()=>{
      confirmGrant=false;await decide('approve',request);assert.match(replies[0]!,/not confirmed/);
      assert.equal((await rows())[0]!.status,'pending');confirmGrant=true;
    });
    await t.test('approval adds only the requested role, preserves existing roles and records one decision',async()=>{
      await decide('approve',request);assert.equal((await rows())[0]!.status,'approved');
      assert.deepEqual([...target.roles.cache.keys()],['existing-role',requested.id]);
      const count=roleAdds;await decide('approve',request);assert.match(replies[0]!,/already approved/);assert.equal(roleAdds,count);
      assert.equal((await db.query("SELECT * FROM audit WHERE action='role_approved'")).rows.length,1);
    });
    await t.test('denial assigns no role and permits a later request',async()=>{
      const another=ROLE_OPTIONS[0];
      await service.onReaction(reaction(another.emoji as any),{id:'member',bot:false} as any);
      const second=(await rows()).find(r=>r.role_id===another.id)!;
      const count=roleAdds;await decide('deny',second);assert.equal(roleAdds,count);
      assert.equal((await rows()).find(r=>r.id===second.id)!.status,'denied');
      await service.onReaction(reaction(another.emoji as any),{id:'member',bot:false} as any);
      assert.equal((await rows()).filter(r=>r.status==='pending').length,1);
    });
  } finally {await db.close();}
});
