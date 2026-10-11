import 'dotenv/config';
import { REST, Routes } from 'discord.js';
const api = new REST({version:'10'}).setToken(process.env.DISCORD_TOKEN!);
try {
  const self = await api.get(Routes.user()) as {id:string;username:string};
  const guild = process.env.GUILD_ID!;
  const board = process.env.LEADERBOARD_CHANNEL_ID!;
  const commands = await api.get(Routes.applicationGuildCommands(self.id,guild)) as {name:string}[];
  const messages = await api.get(Routes.channelMessages(board),{query:new URLSearchParams({limit:'10'})}) as {id:string;author:{id:string};embeds:{title?:string;description?:string}[]}[];
  console.log(JSON.stringify({botId:self.id,botName:self.username,guildId:guild,channelId:board,
    commands:commands.map(c=>c.name),boardMessages:messages.filter(m=>m.author.id===self.id).map(m=>({id:m.id,embeds:m.embeds}))},null,2));
} catch (e) { console.error('Live inspection failed; code:',(e as {code?:unknown}).code ?? 'unknown'); process.exitCode=1; }
