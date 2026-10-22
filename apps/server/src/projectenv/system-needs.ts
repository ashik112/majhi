/**
 * What a Python package needs on the system to build when it has no wheel for the runner (Debian package
 * names, the runner image is Debian). Keys are normalized package names (`pythonName`). A small typed table
 * of the usual ones: a project's own CI file says what it installs first (`apt-get install` in a job), and
 * this fills in what the CI file does not say. An unknown package needs nothing named here; if its build
 * fails the log is on the card.
 */
export const PYTHON_SYSTEM_NEEDS: Readonly<Record<string, readonly string[]>> = {
  psycopg2: ["libpq-dev"],
  mysqlclient: ["default-libmysqlclient-dev", "pkg-config"],
  pycairo: ["libcairo2-dev", "pkg-config"],
  pygobject: ["libgirepository1.0-dev", "libcairo2-dev", "pkg-config"],
  "python-ldap": ["libldap2-dev", "libsasl2-dev"],
  pyodbc: ["unixodbc-dev"],
  pycurl: ["libcurl4-openssl-dev", "libssl-dev"],
  pygraphviz: ["graphviz-dev"],
  xmlsec: ["libxmlsec1-dev", "pkg-config"],
  pyaudio: ["portaudio19-dev"],
  "python-magic": ["libmagic1"],
  "dbus-python": ["libdbus-1-dev", "libglib2.0-dev"],
  pyqt5: ["qtbase5-dev"],
  "pillow-heif": ["libheif-dev"],
  "face-recognition": ["cmake"],
  dlib: ["cmake"],
  "python-snappy": ["libsnappy-dev"],
  pylibmc: ["libmemcached-dev", "zlib1g-dev"],
};

/** Names a Debian package may have: lowercase letters, digits and `+ - .`, starting with a letter or digit. */
export function isDebianPackage(name: string): boolean {
  if (name.length === 0 || name.length > 100) return false;
  return [...name].every((c, i) => {
    const code = c.charCodeAt(0);
    const alnum = (code >= 97 && code <= 122) || (code >= 48 && code <= 57);
    return alnum || (i > 0 && (c === "+" || c === "-" || c === "."));
  });
}

/** The system packages of the known Python packages in `names`, valid and without duplicates. */
export function systemFor(names: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const name of names) for (const pkg of PYTHON_SYSTEM_NEEDS[name] ?? []) out.add(pkg);
  return [...out];
}
