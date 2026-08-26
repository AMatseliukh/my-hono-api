import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { createMiddleware } from 'hono/factory'
import {
  createClient,
  type PostgrestError,
  type SupabaseClient,
  type User,
} from '@supabase/supabase-js'

type Bindings = {
  SUPABASE_URL: string
  SUPABASE_ANON_KEY: string
}

// Те, що middleware кладе в контекст запиту через c.set().
type Variables = {
  supabase: SupabaseClient
  user: User
}

type Env = { Bindings: Bindings; Variables: Variables }

const app = new Hono<Env>()

app.use('/*', cors())

// Postgres: "invalid input syntax for type uuid". Такий id не може існувати,
// тому відповідаємо 404, а не 500.
const isMalformedId = (error: PostgrestError) => error.code === '22P02'

// Вимагає Bearer-токен і кладе в контекст клієнта, прив'язаного до цього
// користувача. Клієнт створюється з anon-ключем — уся ізоляція даних
// тримається на RLS, яка читає auth.uid() із цього ж токена.
const requireAuth = createMiddleware<Env>(async (c, next) => {
  // Відсутні змінні — не провина клієнта, а неправильно запущений воркер.
  if (!c.env.SUPABASE_URL || !c.env.SUPABASE_ANON_KEY) {
    return c.json({ error: 'Server is misconfigured' }, 500)
  }

  const header = c.req.header('Authorization')

  if (!header?.startsWith('Bearer ')) {
    return c.json({ error: 'Authorization header with a Bearer token is required' }, 401)
  }

  const token = header.slice('Bearer '.length)

  const supabase = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  })

  let user: User

  try {
    // Перевіряє підпис і термін дії токена.
    const { data, error } = await supabase.auth.getUser(token)

    if (error || !data.user) {
      return c.json({ error: 'Invalid or expired token' }, 401)
    }

    user = data.user
  } catch {
    // Зіпсований токен може зламати розбір ще до відповіді сервера.
    return c.json({ error: 'Invalid or expired token' }, 401)
  }

  c.set('supabase', supabase)
  c.set('user', user)

  await next()
})

// Захищаємо лише роботу з даними. / і /health лишаються відкритими,
// щоб перевірка живості сервісу не вимагала облікового запису.
app.use('/todos', requireAuth)
app.use('/todos/*', requireAuth)

app.get('/', (c) => {
  return c.text('Hello Hono!')
})

app.get('/health', (c) => {
  return c.json({ ok: true })
})

app.get('/todos', async (c) => {
  const { data, error } = await c
    .get('supabase')
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

  // user_id не передаємо: у колонки стоїть default auth.uid(),
  // тому база проставить власника сама з токена.
  const { data, error } = await c
    .get('supabase')
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
  const { data, error } = await c
    .get('supabase')
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

  const { data, error } = await c
    .get('supabase')
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

  // Чужий рядок RLS не поверне — для клієнта він просто не існує.
  if (!data) {
    return c.json({ error: 'Todo not found' }, 404)
  }

  return c.json(data)
})

app.delete('/todos/:id', async (c) => {
  const { data, error } = await c
    .get('supabase')
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
