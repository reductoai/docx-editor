import { Template } from 'e2b'

export const template = Template({ fileContextPath: '..' })
  .fromImage('ubuntu:22.04')
  .runCmd([
    'apt-get update',
    'DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends libreoffice-writer python3-uno python3 python3-pip python3-venv curl ca-certificates unzip',
    'rm -rf /var/lib/apt/lists/*',
  ], { user: 'root' })
  // Install headless-word via pip into system Python (needs UNO from system packages)
  .runCmd('pip3 install headless-word', { user: 'root' })
  .runCmd('curl -fsSL https://bun.sh/install | bash', { user: 'root' })
  .runCmd('mkdir -p /home/user/app/workspaces', { user: 'root' })
  .copy('server.js', '/home/user/app/server.js', { user: 'root' })
  .copy('workspace_tool.py', '/home/user/app/workspace_tool.py', { user: 'root' })
  .copy('package.json', '/home/user/app/package.json', { user: 'root' })
