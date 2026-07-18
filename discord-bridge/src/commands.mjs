import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';

function addTaskOption(command, required = false) {
  return command.addStringOption((option) => option
    .setName('task')
    .setDescription('Codex task ID or a recent task selected by autocomplete')
    .setRequired(required)
    .setAutocomplete(true));
}

function addPromptOption(command) {
  return command.addStringOption((option) => option
    .setName('prompt')
    .setDescription('Codexに送る指示')
    .setRequired(true)
    .setMaxLength(4000));
}

export const codexCommand = new SlashCommandBuilder()
  .setName('codex')
  .setDescription('Codex Desktopのタスクを表示・操作します')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((command) => command
    .setName('status')
    .setDescription('Bot、app-server、購読タスクの状態を表示します'))
  .addSubcommand((command) => command
    .setName('tasks')
    .setDescription('最近のCodexタスクを選択して開きます')
    .addStringOption((option) => option
      .setName('search')
      .setDescription('名前、本文、作業フォルダの検索語')
      .setMaxLength(200)))
  .addSubcommand((command) => addTaskOption(command
    .setName('open')
    .setDescription('タスク専用Discordチャンネルを作成または開きます'), true))
  .addSubcommand((command) => addTaskOption(addPromptOption(command
    .setName('deliver')
    .setDescription('稼働中ならsteer、待機中なら新しいターンとして送信します')))
    .addAttachmentOption((option) => option
      .setName('attachment')
      .setDescription('画像または200KB以下のテキストファイル')))
  .addSubcommand((command) => addTaskOption(addPromptOption(command
    .setName('send')
    .setDescription('待機中タスクに新しいターンを送信します')))
    .addAttachmentOption((option) => option
      .setName('attachment')
      .setDescription('画像または200KB以下のテキストファイル')))
  .addSubcommand((command) => addTaskOption(addPromptOption(command
    .setName('steer')
    .setDescription('稼働中タスクへ追加指示を送ります'))))
  .addSubcommand((command) => addTaskOption(command
    .setName('compose')
    .setDescription('モバイル向け複数行入力画面を開きます')
    .addStringOption((option) => option
      .setName('mode')
      .setDescription('送信方法')
      .setRequired(true)
      .addChoices(
        { name: '自動 (deliver)', value: 'deliver' },
        { name: '新しいターン (send)', value: 'send' },
        { name: '追加指示 (steer)', value: 'steer' },
      ))))
  .addSubcommand((command) => addTaskOption(command
    .setName('interrupt')
    .setDescription('確認後、稼働中ターンを中断します')))
  .addSubcommand((command) => addTaskOption(command
    .setName('watch')
    .setDescription('タスクチャンネルの通知量を設定します')
    .addStringOption((option) => option
      .setName('level')
      .setDescription('quietは完了と承認のみ、verboseは全itemを表示')
      .setRequired(true)
      .addChoices(
        { name: 'quiet', value: 'quiet' },
        { name: 'normal', value: 'normal' },
        { name: 'verbose', value: 'verbose' },
      ))))
  .addSubcommand((command) => command
    .setName('pending')
    .setDescription('未回答の承認・入力要求を表示します'))
  .addSubcommand((command) => command
    .setName('sync')
    .setDescription('全タスクとDiscordカテゴリを今すぐ再同期します'))
  .addSubcommand((command) => addTaskOption(command
    .setName('refresh')
    .setDescription('タスク状態をapp-serverから再取得します')))
  .addSubcommand((command) => command
    .setName('help')
    .setDescription('主要操作と安全境界を表示します'));

export const commandPayload = [codexCommand.toJSON()];
