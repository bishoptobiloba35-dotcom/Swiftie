import { pool } from "./db.js";

export async function createRating(input: {
  deliveryId: string;
  raterUserId: string;
  ratedUserId: string;
  stars: number;
  comment?: string;
}) {
  if (!pool) throw new Error("Database is not configured");
  const result = await pool.query(
    `INSERT INTO ratings (delivery_id, rater_user_id, rated_user_id, stars, comment)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING id, delivery_id, rater_user_id, rated_user_id, stars, comment, created_at`,
    [input.deliveryId, input.raterUserId, input.ratedUserId, input.stars, input.comment?.trim() || null]
  );
  return result.rows[0];
}

export async function listRatingsForUser(userId: string) {
  if (!pool) throw new Error("Database is not configured");
  const result = await pool.query(
    `SELECT id, delivery_id, rater_user_id, rated_user_id, stars, comment, created_at
     FROM ratings WHERE rated_user_id=$1 ORDER BY created_at DESC LIMIT 100`,
    [userId]
  );
  return result.rows;
}
