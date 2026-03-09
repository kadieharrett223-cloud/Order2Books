const path = require('path')
const fs = require('fs/promises')
const sqlite3 = require('sqlite3')
const { open } = require('sqlite')

let dbPromise

function getDatabaseFilePath() {
  if (process.env.VERCEL) {
    return '/tmp/order2books.sqlite'
  }
  return path.join(__dirname, 'data.sqlite')
}

async function getDb() {
  if (!dbPromise) {
    dbPromise = open({
      filename: getDatabaseFilePath(),
      driver: sqlite3.Database,
    })
  }

  const db = await dbPromise
  await db.exec('PRAGMA foreign_keys = ON;')
  return db
}

async function migrate() {
  const db = await getDb()
  const migrationPath = path.join(__dirname, 'migrations', '001_init.sql')
  const sql = await fs.readFile(migrationPath, 'utf8')
  await db.exec(sql)
}

module.exports = {
  getDb,
  migrate,
}
