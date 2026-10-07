import { Link } from "@tanstack/react-router";

/** A task id that opens the task. */
export function TaskLink({ id }: { id: string }) {
  return (
    <Link
      to="/t/$taskId"
      params={{ taskId: id }}
      search={{}}
      title={`Open ${id}`}
      className="font-mono text-xs text-blue hover:underline"
    >
      {id}
    </Link>
  );
}
