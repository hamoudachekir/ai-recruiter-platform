# MongoDB dump (`ai_recruiter`)

Gzipped `mongodump` of the local `ai_recruiter` database for moving the project to another machine.

**Warning:** this dump includes real app data (users, jobs, interviews, messages). Treat it as sensitive. Do not share the repo publicly with this folder if it contains production credentials or personal data.

## Restore on another laptop

1. Install MongoDB Server (and optionally [MongoDB Database Tools](https://www.mongodb.com/try/download/database-tools)).
2. Start MongoDB so `mongodb://127.0.0.1:27017` is reachable.
3. From the repo root:

```powershell
mongorestore --uri="mongodb://127.0.0.1:27017" --gzip --drop .\data\mongodb-dump
```

`--drop` replaces existing collections in `ai_recruiter` with the dump.

4. Point your `.env` files at the same DB, e.g.:

```env
MONGO_URI=mongodb://localhost:27017/ai_recruiter
MONGODB_URL=mongodb://localhost:27017
MONGODB_DATABASE=ai_recruiter
```

## Refresh this dump (this machine)

```powershell
mongodump --uri="mongodb://127.0.0.1:27017" --db=ai_recruiter --out=.\data\mongodb-dump --gzip
```
