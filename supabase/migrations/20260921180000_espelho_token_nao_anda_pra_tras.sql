-- H93 (2026-09-21) — o espelho do company token não pode andar pra trás, e a
-- trava tem que valer pra QUALQUER escritor, não só pro caminho do app.
--
-- O acidente: uma sessão renovou o token (o refresh_token do GHL é de USO
-- ÚNICO, então o par novo só existia na linha do espelho) e, meia hora depois,
-- outro processo copiou a linha da tabela antiga por cima. O access_token velho
-- ainda era válido, então NADA quebrou na hora — o estrago só apareceria na
-- renovação seguinte, 8h depois, de madrugada.
--
-- A guarda em `gravarTokenEspelho` cobre `src/lib/ghl/*`. Mas três scripts de
-- emergência escrevem direto na tabela — e script de emergência é justo o que
-- alguém roda às 3 da manhã com a plataforma muda. Por isso a regra desce pro
-- banco: aqui não tem como passar por fora.
--
-- Critério é o `iat` do access_token, assinado pelo GHL: descreve o PAR, não a
-- escrita. `updated_at` não serve — os escritores usam convenções diferentes
-- (uns carimbam a execução, outros preservam a origem).

-- base64url → jsonb. Repõe o padding, que o JWT omite.
create or replace function ghl_jwt_payload(jwt text)
returns jsonb
language plpgsql
immutable
as $$
declare
  parte text;
  resto int;
begin
  parte := split_part(jwt, '.', 2);
  if parte is null or parte = '' then
    return null;
  end if;
  parte := translate(parte, '-_', '+/');
  resto := length(parte) % 4;
  if resto > 0 then
    parte := parte || repeat('=', 4 - resto);
  end if;
  return convert_from(decode(parte, 'base64'), 'UTF8')::jsonb;
exception
  when others then
    -- Token que não é JWT legível não bloqueia escrita: quem decide aí é a
    -- camada da aplicação. A trava existe pra impedir REGRESSÃO comprovada.
    return null;
end;
$$;

comment on function ghl_jwt_payload(text) is
  'Payload de um JWT base64url, ou NULL se ilegível. Usado pela trava anti-regressão do espelho de token (H93).';

create or replace function ghl_espelho_nao_regride()
returns trigger
language plpgsql
as $$
declare
  iat_novo numeric;
  iat_velho numeric;
begin
  iat_novo  := (ghl_jwt_payload(new.access_token) ->> 'iat')::numeric;
  iat_velho := (ghl_jwt_payload(old.access_token) ->> 'iat')::numeric;

  -- Sem os dois carimbos não dá pra ordenar: deixa passar (a aplicação decide).
  if iat_novo is null or iat_velho is null then
    return new;
  end if;

  if iat_novo < iat_velho then
    raise exception
      'espelho do company token andaria pra tras: par novo emitido em % e o gravado em % (company=%). O refresh_token do par gravado pode ja ter sido consumido — sobrescrever perde a rotacao.',
      to_timestamp(iat_novo), to_timestamp(iat_velho), old.company_id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_ghl_espelho_nao_regride on ghl_company_tokens;
create trigger trg_ghl_espelho_nao_regride
  before update on ghl_company_tokens
  for each row
  execute function ghl_espelho_nao_regride();
