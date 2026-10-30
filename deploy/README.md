# Moving PBMP Camera to a new host

Zeabur's shared cluster pauses on 1 December and shuts down on 31 December. The app is one Docker
image plus one data folder, `/src/server/data` (the SQLite database and every photo, video, model,
and training frame), so moving means: deploy the same image elsewhere, then copy that folder.

## 1. Turn on backups on Zeabur

Add one environment variable to the Zeabur service and redeploy:

```
ADMIN_TOKEN=<a long random string, at least 16 characters>
```

Make one with `openssl rand -hex 24`. Without it the admin endpoints answer 404.

Check what is there:

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://reactcamapp.zeabur.app/api/admin/stats
```

## 2. Deploy on the new host

Pick one. Each keeps `/src/server/data` on a persistent volume, listens on port 8080, and checks
`/api/health`. Set the same `ADMIN_TOKEN` there.

**Fly.io** (`fly.toml`, Mumbai region):

```bash
fly launch --copy-config --no-deploy        # pick your own app name
fly volumes create pbmp_data --size 10 --region bom
fly secrets set ADMIN_TOKEN=...
fly deploy
```

**Railway** (`railway.json`): create a service from this GitHub repo, add a volume mounted at
`/src/server/data`, and set `ADMIN_TOKEN` under Variables. Railway sets `PORT` itself.

**Your own server** (`deploy/vps`): any Linux machine with Docker and a domain pointing at it.

```bash
cd deploy/vps
DOMAIN=camera.example.com ADMIN_TOKEN=... docker compose up -d --build
```

Caddy gets the HTTPS certificate on its own. Phones need HTTPS for the camera.

## 3. Copy the data

Download a backup from Zeabur, then send it to the new host. The new host must still be empty:
a restore never overwrites a server that already has sessions.

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" -o pbmp-backup.tar.gz \
  https://reactcamapp.zeabur.app/api/admin/backup

curl -H "Authorization: Bearer $ADMIN_TOKEN" -X POST -T pbmp-backup.tar.gz \
  https://NEW-HOST/api/admin/restore
```

The restore answers with the same counts as `/api/admin/stats` on Zeabur. Compare them. The backup
is a `.tar.gz` with `pbmp.sqlite` and `media/`; keep a copy somewhere safe.

## 4. Switch over

Open the new address on a phone and check one session, one video, and Workouts. Session links keep
working on the new host after changing only the domain, keys included. Then update the address in
the native apps (`PbmpClient("https://NEW-HOST")`) and stop the Zeabur service.
