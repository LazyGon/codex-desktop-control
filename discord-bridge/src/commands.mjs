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
  .addSubcommand((command) => addTaskOption(command
    .setName('status')
    .setDescription('Bot、app-server、またはタスクの詳細状態を表示します')))
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
  .addSubcommand((command) => addTaskOption(command
    .setName('model')
    .setDescription('現在のモデルを表示または変更します'))
    .addStringOption((option) => option
      .setName('model')
      .setDescription('app-serverのモデルカタログから選択')
      .setAutocomplete(true)))
  .addSubcommand((command) => addTaskOption(command
    .setName('reasoning')
    .setDescription('推論強度を表示または変更します'))
    .addStringOption((option) => option
      .setName('effort')
      .setDescription('モデル既定値または推論強度')
      .addChoices(
        { name: 'model default', value: '__default__' },
        { name: 'minimal', value: 'minimal' },
        { name: 'low', value: 'low' },
        { name: 'medium', value: 'medium' },
        { name: 'high', value: 'high' },
        { name: 'xhigh', value: 'xhigh' },
      )))
  .addSubcommand((command) => addTaskOption(command
    .setName('permissions')
    .setDescription('権限プロファイルを表示または確認後に変更します'))
    .addStringOption((option) => option
      .setName('profile')
      .setDescription('app-serverの権限プロファイルから選択')
      .setAutocomplete(true)))
  .addSubcommand((command) => addTaskOption(command
    .setName('mode')
    .setDescription('Plan / Defaultモードを表示または変更します'))
    .addStringOption((option) => option
      .setName('mode')
      .setDescription('collaboration mode')
      .addChoices(
        { name: 'Plan', value: 'plan' },
        { name: 'Default', value: 'default' },
      )))
  .addSubcommand((command) => addTaskOption(command
    .setName('memory')
    .setDescription('タスクmemoryを表示または変更します'))
    .addStringOption((option) => option
      .setName('mode')
      .setDescription('task memory mode')
      .addChoices(
        { name: 'Enabled', value: 'enabled' },
        { name: 'Disabled', value: 'disabled' },
      )))
  .addSubcommand((command) => command
    .setName('usage')
    .setDescription('アカウント使用量とrate limitを表示します'))
  .addSubcommand((command) => addTaskOption(command
    .setName('resources')
    .setDescription('MCP、Skills、Plugins、Hooksなどを表示します')
    .addStringOption((option) => option
      .setName('kind')
      .setDescription('表示するCodexリソース')
      .setRequired(true)
      .addChoices(
        { name: 'MCP servers', value: 'mcp' },
        { name: 'Skills', value: 'skills' },
        { name: 'Plugins', value: 'plugins' },
        { name: 'Hooks', value: 'hooks' },
        { name: 'Experimental features', value: 'features' },
      ))))
  .addSubcommand((command) => addTaskOption(command
    .setName('goal')
    .setDescription('タスクのgoalを表示・設定・解除します')
    .addStringOption((option) => option
      .setName('action')
      .setDescription('goal操作')
      .setRequired(true)
      .addChoices(
        { name: 'view', value: 'view' },
        { name: 'set', value: 'set' },
        { name: 'clear', value: 'clear' },
      )))
    .addStringOption((option) => option
      .setName('objective')
      .setDescription('setで設定するgoal本文')
      .setMaxLength(4000))
    .addIntegerOption((option) => option
      .setName('token-budget')
      .setDescription('省略可能なtoken budget')
      .setMinValue(1)))
  .addSubcommand((command) => addTaskOption(command
    .setName('compact')
    .setDescription('確認後にタスクのcontextをcompactします')))
  .addSubcommand((command) => addTaskOption(command
    .setName('fork')
    .setDescription('確認後にこのタスクから新しいタスクを作ります'))
    .addStringOption((option) => option
      .setName('last-turn')
      .setDescription('このturnまでを含めてfork（省略時は全履歴）')))
  .addSubcommand((command) => addTaskOption(command
    .setName('review')
    .setDescription('コードレビューを開始します')
    .addStringOption((option) => option
      .setName('target')
      .setDescription('レビュー対象')
      .setRequired(true)
      .addChoices(
        { name: 'uncommitted changes', value: 'uncommitted' },
        { name: 'base branch', value: 'base' },
        { name: 'commit', value: 'commit' },
        { name: 'custom instructions', value: 'custom' },
      )))
    .addStringOption((option) => option
      .setName('value')
      .setDescription('base branch、commit SHA、またはcustom instructions')
      .setMaxLength(4000))
    .addStringOption((option) => option
      .setName('delivery')
      .setDescription('現在のタスク内または新しいタスク')
      .addChoices(
        { name: 'inline', value: 'inline' },
        { name: 'detached', value: 'detached' },
      )))
  .addSubcommand((command) => addTaskOption(command
    .setName('terminals')
    .setDescription('背景ターミナルを表示または確認後に終了します')
    .addStringOption((option) => option
      .setName('action')
      .setDescription('terminal操作')
      .setRequired(true)
      .addChoices(
        { name: 'list', value: 'list' },
        { name: 'terminate', value: 'terminate' },
      )))
    .addStringOption((option) => option
      .setName('process')
      .setDescription('終了対象のapp-server process ID')))
  .addSubcommand((command) => command
    .setName('help')
    .setDescription('主要操作と安全境界を表示します'));

export const commandPayload = [codexCommand.toJSON()];
