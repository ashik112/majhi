import { endpointId, type MapAnswer, type MapEndpoint, type MapView } from "@majhi/shared";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Select } from "@/components/ui/select";
import { useAnswerAddress } from "@/lib/map-queries";
import { addressText, unansweredAddresses } from "./model";

/**
 * "Add a link": the addresses the projects call that nobody owns yet. Say which project one is, that it
 * is an outside service, or that it is not a call to show; the answer holds for every later update.
 */
export function AddressDialog({ view, onClose }: { view: MapView; onClose: () => void }) {
  const answer = useAnswerAddress(view.org);
  const addresses = unansweredAddresses(view);
  const projects = view.map.nodes.filter((n) => n.project !== undefined);
  const given = view.map.resolutions;
  const say = (e: Pick<MapEndpoint, "host" | "port" | "scope">, to: MapAnswer | undefined) =>
    answer.mutate({
      address: addressText(e),
      ...(e.scope === undefined ? {} : { scope: e.scope }),
      ...(to === undefined ? {} : { to }),
    });
  return (
    <Modal label="Add a link" onClose={onClose} className="w-[520px]">
      <div className="flex max-h-[calc(100dvh-64px)] flex-col gap-4 overflow-y-auto p-5">
        <div className="flex flex-col gap-1">
          <h2 className="text-md font-semibold text-fg">Add a link</h2>
          <p className="text-sm text-fg-muted">
            These addresses are called by your projects. Say what each one is and the map draws the line.
          </p>
        </div>
        {addresses.length === 0 ? (
          <p className="text-base text-fg-faint">Every address has an answer.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {addresses.map((e) => {
              const from = [...new Set(e.refs.map((r) => r.project))];
              return (
                <li key={e.id} className="flex flex-col gap-1.5 rounded-lg border border-line p-2.5">
                  <span className="truncate text-base text-fg" title={e.id}>
                    Talks to <span className="font-mono text-sm">{addressText(e)}</span>
                  </span>
                  <span
                    className="truncate text-sm text-fg-muted"
                    title={e.refs.map((r) => `${r.project}/${r.file}:${r.line}`).join("\n")}
                  >
                    From {from.join(", ")}
                  </span>
                  <div className="flex flex-col gap-2">
                    <Select
                      aria-label={`Which project is ${addressText(e)}`}
                      value=""
                      disabled={answer.isPending}
                      onChange={(ev) =>
                        ev.target.value !== "" && say(e, { kind: "project", project: ev.target.value })
                      }
                      className="h-7 text-sm"
                    >
                      <option value="">Which project?</option>
                      {projects
                        .filter((n) => !(from.length === 1 && from[0] === n.id))
                        .map((n) => (
                          <option key={n.id} value={n.id}>
                            {n.label}
                          </option>
                        ))}
                    </Select>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        disabled={answer.isPending}
                        onClick={() => say(e, { kind: "outside" })}
                      >
                        Outside
                      </Button>
                      <Button
                        size="sm"
                        disabled={answer.isPending}
                        onClick={() => say(e, { kind: "ignore" })}
                      >
                        Ignore
                      </Button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {given.length > 0 && (
          <div className="flex flex-col gap-1">
            <span className="font-mono text-xs tracking-[0.06em] text-fg-muted uppercase">Your answers</span>
            {given.map((r) => (
              <div key={endpointId(r.host, r.port, r.scope)} className="flex items-center gap-2 text-sm">
                <span
                  className="min-w-0 flex-1 truncate font-mono text-fg"
                  title={endpointId(r.host, r.port, r.scope)}
                >
                  {addressText(r)}
                </span>
                <span className="shrink-0 text-fg-muted">
                  {r.to.kind === "project" ? r.to.project : r.to.kind === "outside" ? "outside" : "ignored"}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={answer.isPending}
                  onClick={() => say(r, undefined)}
                >
                  Forget
                </Button>
              </div>
            ))}
          </div>
        )}
        {answer.error !== null && (
          <p role="alert" className="text-sm text-red">
            {answer.error.message}
          </p>
        )}
        <div className="flex justify-end">
          <Button onClick={onClose}>Done</Button>
        </div>
      </div>
    </Modal>
  );
}
