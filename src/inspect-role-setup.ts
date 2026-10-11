import 'dotenv/config';
import { REST, Routes, PermissionsBitField, PermissionFlagsBits,
  type APIRole, type APIChannel, type APIGuildMember } from 'discord.js';
import { ROLE_OPTIONS, ROLE_MENU_CHANNEL, ROLE_APPROVAL_CHANNEL } from './role-requests.js';

// Read-only installation check. Never print credentials or channel messages.
const rest=new REST({version:'10'}).setToken(process.env.DISCORD_TOKEN!);
const guild=process.env.GUILD_ID!;
try {
  const self=await rest.get(Routes.user()) as {id:string};
  const roles=await rest.get(Routes.guildRoles(guild)) as APIRole[];
  const member=await rest.get(Routes.guildMember(guild,self.id)) as APIGuildMember;
  const owned=new Set([guild,...member.roles]);
  const base=roles.filter(r=>owned.has(r.id)).reduce((bits,r)=>bits|BigInt(r.permissions),0n);
  const highest=Math.max(...roles.filter(r=>owned.has(r.id)).map(r=>r.position));
  const channels=[];
  for(const id of [ROLE_MENU_CHANNEL,ROLE_APPROVAL_CHANNEL]) {
    const c=await rest.get(Routes.channel(id)) as APIChannel;
    if(!('permission_overwrites' in c)) throw new Error('Expected guild channel');
    const overwrites=c.permission_overwrites??[];
    const everyone=overwrites.find(o=>o.id===guild);
    let bits=base;
    if(everyone) bits=(bits&~BigInt(everyone.deny))|BigInt(everyone.allow);
    const roleOverwrites=overwrites.filter(o=>o.id!==guild&&o.type===0&&owned.has(o.id));
    bits&=~roleOverwrites.reduce((v,o)=>v|BigInt(o.deny),0n);
    bits|=roleOverwrites.reduce((v,o)=>v|BigInt(o.allow),0n);
    const personal=overwrites.find(o=>o.type===1&&o.id===self.id);
    if(personal) bits=(bits&~BigInt(personal.deny))|BigInt(personal.allow);
    const permissions=new PermissionsBitField(bits);
    channels.push({id,name:'name' in c?c.name:undefined,
      botView:permissions.has(PermissionFlagsBits.ViewChannel),
      botSend:permissions.has(PermissionFlagsBits.SendMessages),
      botEmbed:permissions.has(PermissionFlagsBits.EmbedLinks),
      botReadHistory:permissions.has(PermissionFlagsBits.ReadMessageHistory),
      botReact:permissions.has(PermissionFlagsBits.AddReactions),
      everyoneExplicitViewDenied:!!everyone&&(BigInt(everyone.deny)&PermissionFlagsBits.ViewChannel)!==0n});
  }
  console.log(JSON.stringify({botId:self.id,manageRoles:new PermissionsBitField(base).has(PermissionFlagsBits.ManageRoles),
    administrator:new PermissionsBitField(base).has(PermissionFlagsBits.Administrator),
    channels,roles:ROLE_OPTIONS.map(o=>{
      const role=roles.find(r=>r.id===o.id);
      return{id:o.id,name:role?.name,nameMatches:role?.name===o.name,belowBot:!!role&&role.position<highest,
        permissions:role?new PermissionsBitField(BigInt(role.permissions)).toArray():null};
    }),staffAboveBot:roles.filter(r=>/Staff|Admin|Owner|Moderator|Community Manager|Ticket Support/i.test(r.name))
      .map(r=>({name:r.name,aboveBot:r.position>highest}))},null,2));
} catch(error) {console.error('Role preflight failed; code:',(error as {code?:unknown}).code??'unknown');process.exitCode=1;}
