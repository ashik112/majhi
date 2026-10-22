import { describe, expect, it } from "vitest";
import { classifyRemoteCommand } from "./remote-command.ts";

/**
 * Security: the one reader of what a command run on a connected host does. A read runs with no card, a
 * recovery runs once per case, and everything that cannot be read as one of the two is a write that asks.
 */
const kind = (line: string) => classifyRemoteCommand(line).kind;

describe("a command run on a connected host", () => {
  it.each([
    "docker ps",
    "docker ps -a --filter name=worker --format '{{.Names}} {{.Status}}'",
    "docker inspect -f '{{.State.Status}}' acme-worker",
    "docker logs --tail 200 acme-worker 2>&1 | grep -i 'stuck' | tail -20",
    "sudo docker logs --since 1h acme-worker",
    "docker stats --no-stream",
    "docker compose -f /srv/acme/docker-compose.yml ps",
    "docker compose logs --tail 50 worker",
    "docker exec acme-worker celery -A app inspect active",
    "docker exec -it acme-redis redis-cli llen celery",
    "docker exec acme-db psql -U app -d app -c \"select count(*) from orders where status = 'pending'\"",
    "cd /srv/acme && docker compose ps",
    "systemctl status acme-api --no-pager",
    "journalctl -u acme-api --since '10 min ago' -n 100",
    "cat /var/log/acme/app.log | tail -50",
    "tail -n 200 /var/log/nginx/error.log | grep 502 | wc -l",
    "psql -h localhost -U app -d app -c 'SELECT 1;'",
    "mysql -u app -e 'show processlist'",
    "redis-cli -n 1 info",
    "curl -s -o /dev/null -w '%{http_code}' http://localhost:8000/health",
    "curl -s localhost:8000/health",
    "df -h && free -m && uptime",
    "ps aux | grep celery | grep -v grep",
    "find /var/log/acme -name '*.log' -mmin -10",
    "timeout 20 docker ps",
    "bash -c 'docker ps'",
    "kubectl get pods -n acme",
  ])("reads: %s", (line) => {
    expect(kind(line)).toBe("read");
  });

  it.each([
    ["docker restart acme-worker", "docker restart acme-worker"],
    ["sudo docker restart acme-worker", "docker restart acme-worker"],
    ["docker restart -t 10 acme-worker && docker ps", "docker restart acme-worker"],
    ["docker compose restart worker", "docker compose restart worker"],
    ["docker compose up -d --force-recreate --no-deps worker", "docker compose up worker"],
    ["systemctl restart acme-api", "systemctl restart acme-api"],
    ["service acme-api restart", "service acme-api restart"],
    ["supervisorctl restart acme-worker", "supervisorctl restart acme-worker"],
    ["kubectl rollout restart deployment/acme-api", "kubectl rollout restart deployment/acme-api"],
  ])("recovers: %s", (line, action) => {
    expect(classifyRemoteCommand(line)).toMatchObject({ kind: "recovery", action });
  });

  it.each([
    // Nothing that stops, removes, builds, pulls or changes what runs.
    "docker stop acme-worker",
    "docker kill acme-worker",
    "docker rm -f acme-worker",
    "docker rmi acme-api:latest",
    "docker volume rm acme-data",
    "docker system prune -af",
    "docker pull acme/api:latest",
    "docker run --rm alpine sh",
    "docker compose down",
    "docker compose up -d",
    "docker compose up -d --build worker",
    "docker compose up -d --pull always worker",
    "docker compose pull worker",
    "docker restart $(docker ps -q)",
    "docker restart acme-worker acme-api",
    "docker restart acme-worker; docker restart acme-api",
    "docker exec acme-worker rm -rf /tmp/cache",
    "docker exec acme-worker supervisorctl restart all",
    "docker exec -it acme-worker sh",
    "docker exec acme-db psql -U app -c 'delete from orders'",
    "systemctl stop acme-api",
    "systemctl disable acme-api",
    "systemctl daemon-reload",
    "supervisorctl restart all",
    "kubectl delete pod acme-api-1",
    "kubectl get secrets -n acme",
    "celery -A app purge -f",
    "redis-cli flushall",
    "redis-cli del celery",
    "psql -c 'update orders set status = 1'",
    "psql -c 'select 1; drop table orders'",
    "psql -c 'with x as (delete from orders returning *) select * from x'",
    "psql -c 'select pg_terminate_backend(123)'",
    "psql -f /tmp/fix.sql",
    "mysql -e 'insert into t values (1)'",
    "psql",
    // Secrets, files and the shell around a read.
    "cat ~/.ssh/id_ed25519",
    "cat /srv/acme/.env",
    "cat /etc/shadow",
    "find / -name '*.log' -delete",
    "find /srv -exec rm {} ;",
    "docker logs acme-worker > /tmp/out.log",
    "docker ps | sh",
    "docker ps | xargs docker rm",
    "echo $(docker ps -q) | cat",
    "docker $ACTION acme-worker",
    "LD_PRELOAD=/tmp/x.so docker ps",
    "curl -X POST http://localhost:8000/restart",
    "curl -d x=1 http://localhost:8000/x",
    "curl -s https://example.com/health",
    "curl -o /tmp/x http://localhost/x",
    "wget -O /tmp/x http://localhost/x",
    "sed -i 's/a/b/' /srv/acme/app.conf",
    "tee /srv/acme/app.conf",
    "rm /srv/acme/cache",
    "git pull",
    "git push origin main",
    "sh -c 'docker rm x'",
    "docker ps '",
    "",
  ])("writes: %s", (line) => {
    expect(kind(line)).toBe("write");
  });
});
