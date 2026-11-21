/** Dependency container. Production wiring in index.ts; tests build their own with fakes. */
import type { AiService } from '@datawan/ai';
import type { Config } from './env';
import type { LineApi } from './line/api';
import type { OwnerNotifier } from './services/notifier';
import type { Broadcaster } from './services/realtime';
import type { Repo } from './services/repo';
import type { ImageStorage } from './services/storage';

export interface Deps {
  cfg: Config;
  repo: Repo;
  line: LineApi;
  ai: AiService;
  notifier: OwnerNotifier;
  realtime: Broadcaster;
  storage: ImageStorage;
  now: () => Date;
}
