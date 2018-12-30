// docker run -d --name postgres -e POSTGRES_PASSWORD=pass -p 5432:5432 mitar/postgres:latest

const {Pool} = require('pg');

const {Manager} = require('./index');
const {UNMISTAKABLE_CHARS} = require('./random');

const CONNECTION_CONFIG = {
  user: 'postgres',
  database: 'postgres',
  password: 'pass',
};

const pool = new Pool(CONNECTION_CONFIG);

const manager = new Manager({
  connectionConfig: CONNECTION_CONFIG,
});

manager.on('start', () => {
  console.log(new Date(), 'manager start');
});

manager.on('error', (error, client) => {
  console.log(new Date(), 'manager error', error);
});

manager.on('end', (error) => {
  console.log(new Date(), 'manager end', error);
});

manager.on('connect', (client) => {
  client.on('notice', (notice) => {
    console.warn(new Date(), notice.message, Object.assign({}, notice));
  });
});

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

(async () => {
  await manager.start();

  await pool.query(`
    CREATE OR REPLACE FUNCTION random_id() RETURNS TEXT LANGUAGE SQL AS $$
      SELECT array_to_string(
        array(
          SELECT SUBSTRING('${UNMISTAKABLE_CHARS}' FROM floor(random()*55)::int+1 FOR 1) FROM generate_series(1, 17)
        ),
        ''
      );
    $$;
    CREATE TABLE IF NOT EXISTS posts (
      "_id" CHAR(17) PRIMARY KEY DEFAULT random_id(),
      "body" JSONB NOT NULL DEFAULT '{}'::JSONB
    );
    CREATE TABLE IF NOT EXISTS comments (
      "_id" CHAR(17) PRIMARY KEY DEFAULT random_id(),
      "postId" CHAR(17) NOT NULL REFERENCES Posts("_id"),
      "body" JSONB NOT NULL DEFAULT '{}'::JSONB
    );
    DELETE FROM comments;
    DELETE FROM posts;
  `);

  let result;
  for (let i = 0; i < 5; i++) {
    result = await pool.query(`
      INSERT INTO posts ("body") VALUES($1) RETURNING _id;
    `, [{'title': `Post title ${i}`}]);

    const postId = result.rows[0]._id;

    for (let j = 0; j < 10; j++) {
      await pool.query(`
        INSERT INTO comments ("postId", "body") VALUES($1, $2);
      `, [postId, {'title': `Comment title ${j}`}]);
    }
  }

  const queries = [
    // All comments with embedded post.
    `SELECT "_id", "body", (SELECT row_to_json(posts) FROM posts WHERE posts."_id"=comments."postId") AS "post" FROM comments`,
    // All posts with embedded comments.
    `SELECT "_id", "body", (SELECT array_to_json(COALESCE(array_agg(row_to_json(comments)), ARRAY[]::JSON[])) FROM comments WHERE comments."postId"=posts."_id") AS "comments" FROM posts`,
  ];

  for (const query of queries) {
    const handle = await manager.query(query, {uniqueColumn: '_id', mode: 'changed'});

    handle.on('start', () => {
      console.log(new Date(), 'query start', handle.queryId);
    });

    handle.on('ready', () => {
      console.log(new Date(), 'query ready', handle.queryId);
    });

    handle.on('refreshed', () => {
      console.log(new Date(), 'query refreshed', handle.queryId);
    });

    handle.on('insert', (row) => {
      console.log(new Date(), 'insert', handle.queryId, row);
    });

    handle.on('update', (row, columns) => {
      console.log(new Date(), 'update', handle.queryId, row, columns);
    });

    handle.on('delete', (row) => {
      console.log(new Date(), 'delete', handle.queryId, row);
    });

    handle.on('error', (error) => {
      console.log(new Date(), 'query error', handle.queryId, error);
    });

    handle.on('end', (error) => {
      console.log(new Date(), 'query end', handle.queryId, error);
    });

    await handle.start();
  }

  await sleep(1000);

  let commentIds = [];
  for (let i = 5; i < 7; i++) {
    result = await pool.query(`
      INSERT INTO posts ("body") VALUES($1) RETURNING _id;
    `, [{'title': `Post title ${i}`}]);

    const postId = result.rows[0]._id;

    for (let j = 0; j < 10; j++) {
      result = await pool.query(`
        INSERT INTO comments ("postId", "body") VALUES($1, $2) RETURNING _id;
      `, [postId, {'title': `Comment title ${j}`}]);

      commentIds.push(result.rows[0]._id);
    }
  }

  await sleep(1000);

  for (let i = 0; i < commentIds.length; i++) {
    await pool.query(`
      UPDATE comments SET "body"=$1 WHERE "_id"=$2;
    `, [{'title': `Comment new title ${i}`}, commentIds[i]]);
  }

  await sleep(1000);

  await pool.query(`
    DELETE FROM comments WHERE "_id"=ANY($1);
  `, [commentIds]);

  await sleep(1000);

  await pool.end();
  await manager.stop();
})();
