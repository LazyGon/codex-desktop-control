import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from 'discord.js';
import { threadStatusLabel, truncate } from './util.mjs';

const COLORS = {
  active: 0x2b8a3e,
  neutral: 0x5865f2,
  warning: 0xf0b232,
};

function valueOrUnknown(value) {
  if (value === null || value === undefined || value === '') return 'unknown';
  return String(value);
}

function sandboxLabel(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  return value.type ?? value.mode ?? null;
}

function runtimeSettings(runtime, binding) {
  const stored = binding.runtimeSettings ?? {};
  return {
    model: runtime?.model ?? stored.model ?? null,
    effort: runtime?.reasoningEffort ?? stored.effort ?? null,
    serviceTier: runtime?.serviceTier ?? stored.serviceTier ?? null,
    approvalPolicy: runtime?.approvalPolicy ?? stored.approvalPolicy ?? null,
    sandbox: runtime?.sandbox ?? stored.sandbox ?? null,
    activePermissionProfile: runtime?.activePermissionProfile ?? stored.activePermissionProfile ?? null,
    collaborationMode: stored.collaborationMode ?? null,
    personality: stored.personality ?? null,
  };
}

function availableSelect(customId, placeholder, options, current = null) {
  const menu = new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder(placeholder);
  if (options.length === 0) {
    menu.setDisabled(true).addOptions(new StringSelectMenuOptionBuilder()
      .setLabel('利用可能な候補がありません')
      .setValue('__unavailable__'));
    return menu;
  }
  menu.addOptions(options.slice(0, 25).map((option) => {
    const item = new StringSelectMenuOptionBuilder()
      .setLabel(truncate(option.label, 100, ''))
      .setValue(option.value);
    if (option.description) item.setDescription(truncate(option.description, 100, ''));
    if (option.emoji) item.setEmoji(option.emoji);
    if (option.value === current) item.setDefault(true);
    return item;
  }));
  return menu;
}

function selectedModel(models, modelId) {
  return models.find((model) => model.model === modelId || model.id === modelId)
    ?? models.find((model) => model.isDefault)
    ?? models[0]
    ?? null;
}

export function taskControlPayload({ thread, binding, runtime, models, profiles, modes, goal, terminals }) {
  const settings = runtimeSettings(runtime, binding);
  const model = selectedModel(models, settings.model);
  const currentMode = settings.collaborationMode?.mode ?? null;
  const memoryMode = binding.memoryMode ?? 'unknown';
  const embed = new EmbedBuilder()
    .setTitle(truncate(`Codex controls - ${thread.name ?? binding.name ?? thread.id}`, 256, ''))
    .setColor(thread.status?.type === 'active' ? COLORS.active : COLORS.neutral)
    .addFields(
      { name: 'Model', value: valueOrUnknown(settings.model), inline: true },
      { name: 'Reasoning', value: valueOrUnknown(settings.effort ?? model?.defaultReasoningEffort), inline: true },
      { name: 'Fast / tier', value: valueOrUnknown(settings.serviceTier ?? 'default'), inline: true },
      { name: 'Permissions', value: valueOrUnknown(settings.activePermissionProfile?.id ?? sandboxLabel(settings.sandbox)), inline: true },
      { name: 'Mode', value: valueOrUnknown(currentMode), inline: true },
      { name: 'Personality', value: valueOrUnknown(settings.personality), inline: true },
      { name: 'Memory', value: memoryMode, inline: true },
      { name: 'Goal', value: goal ? truncate(goal.objective, 1000) : 'none', inline: false },
      { name: 'Background terminals', value: String(terminals.length), inline: true },
      { name: 'Task', value: `\`${thread.id}\`` },
    )
    .setFooter({ text: 'Changes apply to subsequent turns through the shared app-server.' });

  const modelOptions = models.filter((candidate) => !candidate.hidden).map((candidate) => ({
    label: candidate.displayName || candidate.model,
    value: candidate.model,
    description: candidate.description,
  }));
  if (settings.model && !modelOptions.some((option) => option.value === settings.model)) {
    modelOptions.unshift({ label: settings.model, value: settings.model, description: 'Current model' });
  }
  const effortOptions = [
    { label: `Model default (${model?.defaultReasoningEffort ?? 'default'})`, value: '__default__' },
    ...(model?.supportedReasoningEfforts ?? []).map((option) => ({
      label: option.reasoningEffort,
      value: option.reasoningEffort,
      description: option.description,
    })),
  ];
  const permissionOptions = profiles.filter((profile) => profile.allowed).map((profile) => ({
    label: profile.id,
    value: profile.id,
    description: profile.description ?? 'Named Codex permission profile',
  }));
  const modeOptions = modes.filter((mode) => mode.mode).map((mode) => ({
    label: mode.name || mode.mode,
    value: mode.mode,
    description: [mode.model, mode.reasoning_effort].filter(Boolean).join(' / ') || 'Codex collaboration mode',
  }));
  const moreOptions = [
    { label: 'Task status', value: 'status', description: 'Runtime settings, goal, usage, and active turn' },
    { label: 'Fast / service tier', value: 'tier', description: 'Select a model service tier' },
    { label: 'Personality', value: 'personality', description: 'Select the response personality' },
    { label: 'Memory', value: 'memory', description: 'Enable or disable task memory' },
    { label: 'Goal', value: 'goal', description: 'View, set, or clear a bounded goal' },
    { label: 'Compact context', value: 'compact', description: 'Compact the current task context' },
    { label: 'Fork task', value: 'fork', description: 'Create a new task from this task' },
    { label: 'Review', value: 'review', description: 'Start an inline or detached code review' },
    { label: 'Background terminals', value: 'terminals', description: 'Inspect or terminate app-server terminals' },
  ];

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(availableSelect(`cx:ctl:model:${thread.id}`, 'モデルを選択', modelOptions, settings.model)),
      new ActionRowBuilder().addComponents(availableSelect(`cx:ctl:effort:${thread.id}`, '推論強度を選択', effortOptions, settings.effort ?? '__default__')),
      new ActionRowBuilder().addComponents(availableSelect(`cx:ctl:permission:${thread.id}`, '権限プロファイルを選択', permissionOptions, settings.activePermissionProfile?.id)),
      new ActionRowBuilder().addComponents(availableSelect(`cx:ctl:mode:${thread.id}`, 'Plan / Defaultを選択', modeOptions, currentMode)),
      new ActionRowBuilder().addComponents(availableSelect(`cx:ctl:more:${thread.id}`, 'その他の操作', moreOptions)),
    ],
    allowedMentions: { parse: [] },
  };
}

export function secondarySettingsPayload({ threadId: explicitThreadId, thread, kind, runtime, binding, models }) {
  const threadId = explicitThreadId ?? thread?.id ?? binding.threadId;
  const settings = runtimeSettings(runtime, binding);
  const model = selectedModel(models, settings.model);
  let title;
  let description;
  let menu;
  if (kind === 'tier') {
    title = 'Fast / service tier';
    description = 'モデルが提供する実行サービス階層を選択します。default はモデル既定値へ戻します。';
    const options = [
      { label: 'Default', value: '__default__', description: 'Use the model default service tier' },
      ...(model?.serviceTiers ?? []).map((tier) => ({ label: tier.name || tier.id, value: tier.id, description: tier.description })),
    ];
    menu = availableSelect(`cx:ctl:tier:${threadId}`, 'サービス階層を選択', options, settings.serviceTier ?? '__default__');
  } else if (kind === 'personality') {
    title = 'Personality';
    description = model?.supportsPersonality
      ? '以降のターンに使う応答スタイルを選択します。'
      : '現在のモデルは personality をサポートしていません。';
    menu = availableSelect(`cx:ctl:personality:${threadId}`, 'personalityを選択', model?.supportsPersonality ? [
      { label: 'None', value: 'none', description: 'No personality override' },
      { label: 'Friendly', value: 'friendly', description: 'Warm and conversational' },
      { label: 'Pragmatic', value: 'pragmatic', description: 'Direct and engineering focused' },
    ] : [], settings.personality);
  } else {
    title = 'Task memory';
    description = 'タスク単位の memory mode を切り替えます。';
    menu = availableSelect(`cx:ctl:memory:${threadId}`, 'memory modeを選択', [
      { label: 'Enabled', value: 'enabled', description: 'Allow task memory' },
      { label: 'Disabled', value: 'disabled', description: 'Disable task memory' },
    ], binding.memoryMode ?? null);
  }
  return {
    embeds: [new EmbedBuilder().setTitle(title).setDescription(description).setColor(COLORS.neutral)],
    components: [
      new ActionRowBuilder().addComponents(menu),
      new ActionRowBuilder().addComponents(new ButtonBuilder()
        .setCustomId(`cx:ctl:back:${threadId}`)
        .setLabel('Controlsへ戻る')
        .setStyle(ButtonStyle.Secondary)),
    ],
    allowedMentions: { parse: [] },
  };
}

export function taskStatusEmbed({ thread, binding, runtime, activeTurn, goal, terminals }) {
  const settings = runtimeSettings(runtime, binding);
  const usage = binding.tokenUsage;
  const usageText = usage
    ? `total ${valueOrUnknown(usage.total?.totalTokens)} / context ${valueOrUnknown(usage.modelContextWindow)}`
    : 'not reported';
  return new EmbedBuilder()
    .setTitle(truncate(`Codex status - ${thread.name ?? binding.name ?? thread.id}`, 256, ''))
    .setColor(thread.status?.type === 'active' ? COLORS.active : COLORS.neutral)
    .addFields(
      { name: 'Status', value: threadStatusLabel(thread.status), inline: true },
      { name: 'Active turn', value: activeTurn ? `\`${activeTurn.id}\`` : 'none', inline: true },
      { name: 'Model', value: valueOrUnknown(settings.model), inline: true },
      { name: 'Reasoning', value: valueOrUnknown(settings.effort), inline: true },
      { name: 'Fast / tier', value: valueOrUnknown(settings.serviceTier ?? 'default'), inline: true },
      { name: 'Permissions', value: valueOrUnknown(settings.activePermissionProfile?.id ?? sandboxLabel(settings.sandbox)), inline: true },
      { name: 'Approval', value: valueOrUnknown(settings.approvalPolicy), inline: true },
      { name: 'Mode', value: valueOrUnknown(settings.collaborationMode?.mode), inline: true },
      { name: 'Memory', value: binding.memoryMode ?? 'unknown', inline: true },
      { name: 'Token usage', value: usageText },
      { name: 'Goal', value: goal ? `${goal.status}: ${truncate(goal.objective, 900)}` : 'none' },
      { name: 'Background terminals', value: String(terminals.length), inline: true },
      { name: 'CWD', value: `\`${truncate(runtime?.cwd ?? thread.cwd ?? binding.cwd ?? '(none)', 1000)}\`` },
      { name: 'Task ID', value: `\`${thread.id}\`` },
    )
    .setTimestamp();
}

function formatWindow(label, window) {
  if (!window) return `${label}: unavailable`;
  const reset = window.resetsAt ? `<t:${Math.floor(window.resetsAt)}:R>` : 'unknown reset';
  return `${label}: ${Math.round(window.usedPercent)}% used / ${reset}`;
}

export function accountUsageEmbed({ usage, rateLimits }) {
  const summary = usage?.summary ?? {};
  const buckets = rateLimits?.rateLimitsByLimitId
    ? Object.entries(rateLimits.rateLimitsByLimitId)
    : [['default', rateLimits?.rateLimits]];
  const limits = buckets.filter(([, snapshot]) => snapshot).slice(0, 8).map(([id, snapshot]) => [
    `**${snapshot.limitName ?? id}**`,
    formatWindow('Primary', snapshot.primary),
    formatWindow('Secondary', snapshot.secondary),
  ].join('\n')).join('\n\n') || 'Rate limits are unavailable.';
  return new EmbedBuilder()
    .setTitle('Codex account usage')
    .setColor(COLORS.neutral)
    .addFields(
      { name: 'Lifetime tokens', value: valueOrUnknown(summary.lifetimeTokens), inline: true },
      { name: 'Peak daily tokens', value: valueOrUnknown(summary.peakDailyTokens), inline: true },
      { name: 'Longest turn', value: summary.longestRunningTurnSec == null ? 'unknown' : `${summary.longestRunningTurnSec}s`, inline: true },
      { name: 'Rate limits', value: truncate(limits, 1024) },
    )
    .setTimestamp();
}

function itemLines(items, formatter) {
  const lines = items.slice(0, 25).map(formatter);
  if (items.length > 25) lines.push(`...and ${items.length - 25} more`);
  return lines.join('\n') || 'No entries.';
}

export function resourceInventoryEmbed(kind, result) {
  let title;
  let lines;
  if (kind === 'mcp') {
    title = 'MCP servers';
    lines = itemLines(result, (server) => `- **${server.name}** / auth: ${valueOrUnknown(server.authStatus)} / tools: ${Object.keys(server.tools ?? {}).length}`);
  } else if (kind === 'skills') {
    title = 'Skills';
    const skills = (result.data ?? []).flatMap((entry) => entry.skills ?? []);
    lines = itemLines(skills, (skill) => `- ${skill.enabled ? 'enabled' : 'disabled'} **${skill.name}** / ${skill.scope}`);
  } else if (kind === 'hooks') {
    title = 'Hooks';
    const hooks = (result.data ?? []).flatMap((entry) => entry.hooks ?? []);
    lines = itemLines(hooks, (hook) => `- ${hook.enabled ? 'enabled' : 'disabled'} **${hook.key}** / ${hook.eventName} / ${hook.trustStatus}`);
  } else if (kind === 'plugins') {
    title = 'Plugins';
    const plugins = (result.marketplaces ?? []).flatMap((marketplace) => marketplace.plugins ?? []);
    lines = itemLines(plugins, (plugin) => `- ${plugin.enabled ? 'enabled' : plugin.installed ? 'installed' : 'available'} **${plugin.name}**`);
  } else {
    title = 'Experimental features';
    lines = itemLines(result, (feature) => `- ${feature.enabled ? 'enabled' : 'disabled'} **${feature.displayName ?? feature.name}** / ${feature.stage}`);
  }
  return new EmbedBuilder()
    .setTitle(title)
    .setColor(COLORS.neutral)
    .setDescription(truncate(lines, 4000))
    .setFooter({ text: 'Read-only inventory from the shared app-server.' })
    .setTimestamp();
}

export function goalPayload(threadId, goal) {
  const embed = new EmbedBuilder()
    .setTitle('Codex goal')
    .setColor(goal ? COLORS.active : COLORS.neutral)
    .setDescription(goal ? truncate(goal.objective, 4000) : 'このタスクに goal は設定されていません。');
  if (goal) embed.addFields(
    { name: 'Status', value: valueOrUnknown(goal.status), inline: true },
    { name: 'Token budget', value: valueOrUnknown(goal.tokenBudget), inline: true },
    { name: 'Tokens used', value: valueOrUnknown(goal.tokensUsed), inline: true },
    { name: 'Time used', value: `${goal.timeUsedSeconds ?? 0}s`, inline: true },
  );
  return {
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`cx:ctl:goalset:${threadId}`).setLabel('Goalを設定').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`cx:ctl:goalclear:${threadId}`).setLabel('Goalを解除').setStyle(ButtonStyle.Danger).setDisabled(!goal),
      new ButtonBuilder().setCustomId(`cx:ctl:back:${threadId}`).setLabel('Controlsへ戻る').setStyle(ButtonStyle.Secondary),
    )],
    allowedMentions: { parse: [] },
  };
}

export function reviewPayload(threadId) {
  const menu = availableSelect(`cx:ctl:review:${threadId}`, 'レビュー対象を選択', [
    { label: 'Uncommitted / inline', value: 'uncommitted:inline', description: 'Review working tree changes in this task' },
    { label: 'Uncommitted / detached', value: 'uncommitted:detached', description: 'Review in a new task' },
    { label: 'Base branch / inline', value: 'base:inline', description: 'Enter a base branch name' },
    { label: 'Base branch / detached', value: 'base:detached', description: 'Review against a base branch in a new task' },
    { label: 'Commit / inline', value: 'commit:inline', description: 'Enter a commit SHA' },
    { label: 'Commit / detached', value: 'commit:detached', description: 'Review a commit in a new task' },
    { label: 'Custom / inline', value: 'custom:inline', description: 'Enter custom review instructions' },
    { label: 'Custom / detached', value: 'custom:detached', description: 'Run custom review in a new task' },
  ]);
  return {
    embeds: [new EmbedBuilder().setTitle('Codex review').setDescription('対象と実行先を選択します。').setColor(COLORS.neutral)],
    components: [
      new ActionRowBuilder().addComponents(menu),
      new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`cx:ctl:back:${threadId}`).setLabel('Controlsへ戻る').setStyle(ButtonStyle.Secondary)),
    ],
    allowedMentions: { parse: [] },
  };
}

export function terminalPayload(threadId, terminals) {
  const embed = new EmbedBuilder()
    .setTitle('Background terminals')
    .setColor(terminals.length ? COLORS.warning : COLORS.neutral)
    .setDescription(terminals.length
      ? truncate(itemLines(terminals, (terminal) => `- \`${terminal.processId}\` / PID ${valueOrUnknown(terminal.osPid)} / ${truncate(terminal.command, 160)}`), 4000)
      : 'このタスクに app-server 管理の背景ターミナルはありません。');
  const components = [];
  if (terminals.length) {
    components.push(new ActionRowBuilder().addComponents(availableSelect(
      `cx:ctl:terminal:${threadId}`,
      '終了するターミナルを選択',
      terminals.map((terminal) => ({
        label: `${terminal.processId} / PID ${valueOrUnknown(terminal.osPid)}`,
        value: terminal.processId,
        description: terminal.command,
      })),
    )));
  }
  components.push(new ActionRowBuilder().addComponents(new ButtonBuilder()
    .setCustomId(`cx:ctl:back:${threadId}`)
    .setLabel('Controlsへ戻る')
    .setStyle(ButtonStyle.Secondary)));
  return { embeds: [embed], components, allowedMentions: { parse: [] } };
}
