import { UserError } from "../errors.ts";

/** A task key like `PRV-53`. */
const TASK_KEY = /^[A-Z][A-Z0-9]{0,9}-[1-9][0-9]*$/;

/** Every docker name majhi uses for the containers of one task. */
export interface ContainerNames {
  /** The task key lowercased: `PRV-53` gives `prv-53`. */
  key: string;
  /** The task key as it is, for the `majhi.task` label. */
  task: string;
  /** The preview image, tag `latest`. */
  previewImage: string;
  /** The task's own BuildKit builder. */
  builder: string;
  /**
   * The preview's holder (SPEC 6): it owns the network, the published port and the name the server
   * reaches, and holds the netguard rules. The preview itself shares its network.
   */
  previewContainer: string;
  /** The preview app: the task's own image, in the holder's network namespace. */
  previewApp: string;
  /** The internal network of the task's services. */
  network: string;
  /** A service container. Also its network alias is `name`. */
  service(name: string): string;
  /** The forwarder container of a service on the owner's computer (SPEC 5.14), by connection id. */
  hostForward(id: string): string;
  /** The network that gives that forwarder its route to the computer: only forwarders join it, never a runner. */
  hostNetwork: string;
  /** A named volume majhi creates for the task. */
  volume(name: string): string;
  /** Prefix of every volume of the task. */
  volumePrefix: string;
}

/** The names of the task's containers, networks, volumes, builder and image. One place, so cleanup finds what start made. */
export function containerNames(task: string): ContainerNames {
  if (!TASK_KEY.test(task)) throw new UserError(`${task} is not a task key.`);
  const key = task.toLowerCase();
  return {
    key,
    task,
    previewImage: `majhi-preview-${key}`,
    builder: `majhi-preview-${key}`,
    previewContainer: `majhi-preview-${key}`,
    previewApp: `majhi-preview-${key}-app`,
    network: `majhi-${key}`,
    service: (name) => `majhi-${key}-${name}`,
    hostForward: (id) => `majhi-${key}-host-${id}`,
    hostNetwork: `majhi-${key}-host`,
    volume: (name) => `majhi-${key}-data-${name}`,
    volumePrefix: `majhi-${key}-data-`,
  };
}
