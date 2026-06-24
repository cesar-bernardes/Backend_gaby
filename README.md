# Backend JADE

API Express com persistencia no Supabase.

## Preparar o Supabase

1. Crie um projeto no Supabase.
2. Abra o SQL Editor.
3. Rode o arquivo `Backend/supabase/schema.sql`.
4. Em Project Settings > API, adicione `Studio` em Exposed schemas.
5. Copie a Project URL e a `service_role key`.

A `service_role key` deve ficar apenas no backend. Nunca coloque essa chave no frontend.

## Configuracao

Copie `.env.example` para `.env` e ajuste:

- `JWT_SECRET`: chave secreta usada nos cookies de login.
- `CLIENT_URLS`: URLs do frontend liberadas no CORS.
- `SUPABASE_URL`: URL do projeto Supabase.
- `SUPABASE_SERVICE_ROLE_KEY`: chave `service_role` do Supabase.
- `SUPABASE_SCHEMA`: schema usado no banco. O padrao e `Studio`.
- `ADMIN_PHONE`: telefone que pode entrar como ADM.
- `ADMIN_CODE`: codigo opcional para login como ADM.

## Como rodar

```bash
npm install
npm run dev
```

Por padrao, o backend sobe em `http://localhost:5000`.

Na primeira inicializacao, o backend popula o Supabase com dados iniciais de estudio, servicos, posts e promocoes se as tabelas estiverem vazias.

## Dados salvos

Tudo fica salvo no Supabase:

- clientes e logins
- servicos
- agenda padrao automatica de segunda a sabado, 07:00 ate 17:00
- bloqueios manuais da agenda, incluindo dia inteiro e recorrencia semanal
- agendamentos
- posts do feed
- promocoes e pacotes
- interessados em promocoes
- configuracoes do estudio

## Rotas principais

- `GET /api/health`
- `GET /api/bootstrap`
- `POST /api/auth/check-phone`
- `POST /api/register`
- `POST /api/login`
- `POST /api/logout`
- `GET /api/me`
- `GET/PUT /api/studio`
- `GET/POST/PUT/DELETE /api/services`
- `GET /api/availability`
- `GET/POST/PATCH /api/appointments`
- `PATCH /api/appointments/:id/cancel`
- `PATCH /api/appointments/:id/reschedule`
- `GET/POST/PUT/DELETE /api/promotions`
- `POST /api/promotion-leads`
- `GET/POST/PUT/DELETE /api/feed/posts`
- `GET /api/clients`
- `GET /api/admin/dashboard`
- `GET/PATCH /api/admin/users`
- `GET/POST/PUT/DELETE /api/admin/services`
- `GET /api/admin/availability`
- `POST/PUT/DELETE /api/admin/availability-blocks`
- `GET/PATCH /api/admin/appointments`
