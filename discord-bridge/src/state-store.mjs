import path from 'node:path';
import {
  atomicWriteJson,
  deepClone,
  projectIdFromKey,
  readJsonIfPresent,
} from './util.mjs';

function initialState(guildId) {
  return {
    schemaVersion: 4,
    guildId,
    infrastructure: {
      controlCategoryId: null,
      controlChannelId: null,
      alertsChannelId: null,
      completionsChannelId: null,
      archiveCategoryIds: [],
    },
    projectCategories: {},
    bindings: {},
    lastReadyAt: null,
  };
}

export class StateStore {
  constructor(dataDir, guildId) {
    this.filePath = path.join(dataDir, 'state.json');
    const persisted = readJsonIfPresent(this.filePath);
    this.value = persisted?.guildId === guildId ? persisted : initialState(guildId);
    if (this.value.schemaVersion === 1) {
      this.value.infrastructure.controlCategoryId ??= this.value.infrastructure.categoryId ?? null;
      delete this.value.infrastructure.categoryId;
      this.value.schemaVersion = 2;
    }
    if (this.value.schemaVersion === 2) {
      for (const [projectKey, project] of Object.entries(this.value.projectCategories ?? {})) {
        project.projectId ??= projectIdFromKey(projectKey);
      }
      for (const binding of Object.values(this.value.bindings ?? {})) {
        binding.turnMessages ??= {};
        if (binding.lastCompletedTurnId && binding.lastCompletionMessageId) {
          binding.turnMessages[binding.lastCompletedTurnId] ??= {};
          binding.turnMessages[binding.lastCompletedTurnId].finalMessageIds ??= [binding.lastCompletionMessageId];
          binding.turnMessages[binding.lastCompletedTurnId].status ??= 'completed';
        }
      }
      this.value.schemaVersion = 3;
    }
    if (this.value.schemaVersion === 3) {
      for (const binding of Object.values(this.value.bindings ?? {})) {
        for (const record of Object.values(binding.turnMessages ?? {})) {
          record.cardMessageId ??= record.liveMessageId ?? record.finalMessageIds?.[0] ?? null;
        }
      }
      this.value.schemaVersion = 4;
    }
    if (this.value.schemaVersion !== 4) this.value = initialState(guildId);
    delete this.value.bindings?.undefined;
    for (const binding of Object.values(this.value.bindings ?? {})) {
      binding.snapshotInitialized ??= true;
      binding.turnMessages ??= {};
    }
    this.value.infrastructure.archiveCategoryIds ??= [];
    this.value.projectCategories ??= {};
    delete this.value.autoCatchupProjects;
    this.#write();
  }

  snapshot() {
    return deepClone(this.value);
  }

  update(mutator) {
    mutator(this.value);
    this.#write();
    return this.snapshot();
  }

  binding(threadId) {
    return this.value.bindings[threadId]
      ? { ...deepClone(this.value.bindings[threadId]), threadId }
      : null;
  }

  bindingByChannel(channelId) {
    const entry = Object.entries(this.value.bindings).find(([, binding]) => binding.channelId === channelId);
    return entry ? { threadId: entry[0], ...deepClone(entry[1]) } : null;
  }

  bindings() {
    return Object.entries(this.value.bindings).map(([threadId, binding]) => ({ threadId, ...deepClone(binding) }));
  }

  turnRecord(threadId, turnId) {
    const value = this.value.bindings[threadId]?.turnMessages?.[turnId];
    return value ? deepClone(value) : null;
  }

  setTurnRecord(threadId, turnId, patch) {
    if (!this.value.bindings[threadId]) throw new Error(`Unknown thread binding: ${threadId}`);
    return this.update((state) => {
      state.bindings[threadId].turnMessages ??= {};
      state.bindings[threadId].turnMessages[turnId] = {
        ...state.bindings[threadId].turnMessages[turnId],
        ...patch,
        updatedAt: new Date().toISOString(),
      };
    });
  }

  projectCategory(projectKey) {
    const value = this.value.projectCategories[projectKey];
    return value ? deepClone(value) : null;
  }

  projectCategories() {
    return Object.entries(this.value.projectCategories)
      .map(([projectKey, value]) => ({ projectKey, ...deepClone(value) }))
      .sort((left, right) => left.path.localeCompare(right.path));
  }

  setProjectCategory(projectKey, value) {
    return this.update((state) => {
      state.projectCategories[projectKey] = {
        ...state.projectCategories[projectKey],
        ...value,
        updatedAt: new Date().toISOString(),
      };
    });
  }

  setBinding(threadId, binding) {
    if (typeof threadId !== 'string' || !threadId || threadId === 'undefined') {
      throw new Error('A valid threadId is required for a Discord binding.');
    }
    return this.update((state) => {
      state.bindings[threadId] = { ...state.bindings[threadId], ...binding, updatedAt: new Date().toISOString() };
    });
  }

  removeBinding(threadId) {
    return this.update((state) => {
      delete state.bindings[threadId];
    });
  }

  setInfrastructure(infrastructure) {
    return this.update((state) => {
      state.infrastructure = { ...state.infrastructure, ...infrastructure };
    });
  }

  #write() {
    atomicWriteJson(this.filePath, this.value);
  }
}
