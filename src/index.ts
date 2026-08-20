import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { createClient, type PostgrestError } from '@supabase/supabase-js'

type Bindings = {
  SUPABASE_URL: string
  SUPABASE_SERVICE_ROLE_KEY: string
}

const app = new Hono<{ Bindings: Bindings }>()

app.use('/*', cors())

const db = (env: Bindings) =>
  createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)

// Postgres: "invalid input syntax for type uuid". Такий id не може існувати,
// тому відповідаємо 404, а не 500.
const isMalformedId = (error: PostgrestError) => error.code === '22P02'

app.get('/', (c) => {
  return c.text('Hello Hono!')
})

app.get('/health', (c) => {
  return c.json({ ok: true })
})

app.get('/todos', async (c) => {
  const { data, error } = await db(c.env)
    .from('todos')
    .select('*')
    .order('created_at', { ascending: false })

  if (error) {
    return c.json({ error: error.message }, 500)
  }

  return c.json(data)
})

app.post('/todos', async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Body must be valid JSON' }, 400)
  }

  const { title } = body as { title?: unknown }

  if (typeof title !== 'string' || title.trim() === '') {
    return c.json({ error: '"title" is required and must be a non-empty string' }, 400)
  }

  const { data, error } = await db(c.env)
    .from('todos')
    .insert({ title: title.trim() })
    .select()
    .single()

  if (error) {
    return c.json({ error: error.message }, 500)
  }

  return c.json(data, 201)
})

app.get('/todos/:id', async (c) => {
  const { data, error } = await db(c.env)
    .from('todos')
    .select('*')
    .eq('id', c.req.param('id'))
    .maybeSingle()

  if (error) {
    return isMalformedId(error)
      ? c.json({ error: 'Todo not found' }, 404)
      : c.json({ error: error.message }, 500)
  }

  if (!data) {
    return c.json({ error: 'Todo not found' }, 404)
  }

  return c.json(data)
})

app.patch('/todos/:id', async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Body must be valid JSON' }, 400)
  }

  const { title, is_done } = body as { title?: unknown; is_done?: unknown }
  const patch: { title?: string; is_done?: boolean } = {}

  if (title !== undefined) {
    if (typeof title !== 'string' || title.trim() === '') {
      return c.json({ error: '"title" must be a non-empty string' }, 400)
    }
    patch.title = title.trim()
  }

  if (is_done !== undefined) {
    if (typeof is_done !== 'boolean') {
      return c.json({ error: '"is_done" must be a boolean' }, 400)
    }
    patch.is_done = is_done
  }

  if (Object.keys(patch).length === 0) {
    return c.json({ error: 'Provide at least one of "title" or "is_done"' }, 400)
  }

  const { data, error } = await db(c.env)
    .from('todos')
    .update(patch)
    .eq('id', c.req.param('id'))
    .select()
    .maybeSingle()

  if (error) {
    return isMalformedId(error)
      ? c.json({ error: 'Todo not found' }, 404)
      : c.json({ error: error.message }, 500)
  }

  if (!data) {
    return c.json({ error: 'Todo not found' }, 404)
  }

  return c.json(data)
})

app.delete('/todos/:id', async (c) => {
  const { data, error } = await db(c.env)
    .from('todos')
    .delete()
    .eq('id', c.req.param('id'))
    .select()
    .maybeSingle()

  if (error) {
    return isMalformedId(error)
      ? c.json({ error: 'Todo not found' }, 404)
      : c.json({ error: error.message }, 500)
  }

  if (!data) {
    return c.json({ error: 'Todo not found' }, 404)
  }

  return c.body(null, 204)
})

export default app
