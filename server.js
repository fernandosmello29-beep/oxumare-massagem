const express = require("express");
const { DatabaseSync } = require("node:sqlite");
require("dotenv").config();

const ASAAS_API_KEY = process.env.ASAAS_API_KEY;
const ASAAS_BASE_URL = process.env.ASAAS_BASE_URL;
const ASAAS_WEBHOOK_TOKEN = process.env.ASAAS_WEBHOOK_TOKEN;

async function asaasRequest(endpoint, options = {}) {
    const resposta = await fetch(`${ASAAS_BASE_URL}${endpoint}`, {
        ...options,
        headers: {
            "Content-Type": "application/json",
            "access_token": ASAAS_API_KEY,
            ...(options.headers || {})
        }
    });

    const texto = await resposta.text();

    let dados;

    try {
        dados = JSON.parse(texto);
    } catch {
        dados = { resposta: texto };
    }

    if (!resposta.ok) {
        throw new Error(
            `Asaas ${resposta.status}: ${JSON.stringify(dados)}`
        );
    }

    return dados;
}
function dataHojeSaoPaulo() {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Sao_Paulo",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).format(new Date());
}

function limparDocumento(valor) {
    return String(valor || "").replace(/\D/g, "");
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static("public"));

/*
 * BANCO DE DADOS
 */

const db = new DatabaseSync("./oxumare.db");

db.exec(`
    CREATE TABLE IF NOT EXISTS reservas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        data TEXT NOT NULL,
        horario TEXT NOT NULL,
        nome TEXT NOT NULL,
        whatsapp TEXT NOT NULL,
        escalda_pes INTEGER NOT NULL DEFAULT 0,
        total REAL NOT NULL,
        reserva REAL NOT NULL DEFAULT 50,
        restante REAL NOT NULL,
        status TEXT NOT NULL DEFAULT 'confirmada',
        criado_em TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reservas_temporarias (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        data TEXT NOT NULL,
        horario TEXT NOT NULL,
        nome TEXT NOT NULL,
        cpf TEXT,
        whatsapp TEXT,
        escalda_pes INTEGER NOT NULL DEFAULT 0,
        total REAL,
        asaas_customer_id TEXT,
        asaas_payment_id TEXT,
        pix_payload TEXT,
        pix_encoded_image TEXT,
        pix_expiration TEXT,
        expira_em INTEGER NOT NULL,
        criado_em TEXT NOT NULL
    );
`);
// MIGRAÃ‡ÃƒO DO BANCO EXISTENTE
function adicionarColunaSeNaoExistir(tabela, coluna, definicao) {

    const colunas = db.prepare(
        `PRAGMA table_info(${tabela})`
    ).all();

    const existe = colunas.some(
        item => item.name === coluna
    );

    if (!existe) {

        db.exec(
            `ALTER TABLE ${tabela} ADD COLUMN ${coluna} ${definicao}`
        );

        console.log(
            `Coluna adicionada: ${tabela}.${coluna}`
        );
    }
}

// Garante que a tabela de horários bloqueados exista
db.exec(`
    CREATE TABLE IF NOT EXISTS horarios_bloqueados (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        data TEXT NOT NULL,
        horario TEXT NOT NULL,
        criado_em TEXT NOT NULL,
        UNIQUE(data, horario)
    );
`);

// Garante colunas necessárias na tabela de reservas
adicionarColunaSeNaoExistir(
    "reservas",
    "cpf",
    "TEXT"
);

adicionarColunaSeNaoExistir(
    "reservas",
    "asaas_payment_id",
    "TEXT"
);

// Garante que a tabela de reservas temporÃ¡rias
// tenha todas as colunas necessÃ¡rias.
adicionarColunaSeNaoExistir(
    "reservas_temporarias",
    "nome",
    "TEXT"
);

adicionarColunaSeNaoExistir(
    "reservas_temporarias",
    "cpf",
    "TEXT"
);

adicionarColunaSeNaoExistir(
    "reservas_temporarias",
    "whatsapp",
    "TEXT"
);

adicionarColunaSeNaoExistir(
    "reservas_temporarias",
    "escalda_pes",
    "INTEGER NOT NULL DEFAULT 0"
);

adicionarColunaSeNaoExistir(
    "reservas_temporarias",
    "total",
    "REAL"
);
adicionarColunaSeNaoExistir(
    "reservas_temporarias",
    "asaas_customer_id",
    "TEXT"
);

adicionarColunaSeNaoExistir(
    "reservas_temporarias",
    "asaas_payment_id",
    "TEXT"
);

adicionarColunaSeNaoExistir(
    "reservas_temporarias",
    "pix_payload",
    "TEXT"
);

adicionarColunaSeNaoExistir(
    "reservas_temporarias",
    "pix_encoded_image",
    "TEXT"
);

adicionarColunaSeNaoExistir(
    "reservas_temporarias",
    "pix_expiration",
    "TEXT"
);
/*
 * HORÃRIOS PADRÃƒO
 */

const schedule = [
    "09:00",
    "10:00",
    "11:00",
    "12:00",
    "14:00",
    "15:00",
    "16:00",
    "17:00",
    "18:00",
    "19:00",
    "20:00"
];


/*
 * LIMPA RESERVAS TEMPORÃRIAS EXPIRADAS
 */

function limparReservasTemporarias() {

    db.prepare(`
        DELETE FROM reservas_temporarias
        WHERE expira_em <= ?
    `).run(Date.now());

}


/*
 * TESTE
 */

app.get("/health", (req, res) => {

    res.json({
        status: "ok",
        sistema: "OxumarÃ© Massagem",
        banco: "SQLite"
    });

});


/*
 * HORÃRIOS DISPONÃVEIS
 */

app.get("/api/horarios", (req, res) => {

    const { data } = req.query;

    if (!data) {

        return res.status(400).json({
            erro: "Informe a data."
        });

    }

    limparReservasTemporarias();

    const agora = new Date();

    const horariosDisponiveis = schedule.filter(horario => {

        const dataHorario =
            new Date(`${data}T${horario}:00`);

        /*
         * MÃ­nimo de 1 hora de antecedÃªncia
         */

        if (
            dataHorario.getTime() <
            agora.getTime() + (60 * 60 * 1000)
        ) {

            return false;

        }


        /*
         * Reserva temporÃ¡ria
         */

        const temporaria = db.prepare(`
            SELECT id
            FROM reservas_temporarias
            WHERE data = ?
              AND horario = ?
              AND expira_em > ?
            LIMIT 1
        `).get(
            data,
            horario,
            Date.now()
        );


        if (temporaria) {
            return false;
        }


        /*
         * Reserva confirmada
         */

        const confirmada = db.prepare(`
            SELECT id
            FROM reservas
            WHERE data = ?
              AND horario = ?
              AND status = 'confirmada'
            LIMIT 1
        `).get(
            data,
            horario
        );


        if (confirmada) {
    return false;
}

/*
 * Horário bloqueado pelo administrador
 */
const bloqueado = db.prepare(`
    SELECT id
    FROM horarios_bloqueados
    WHERE data = ?
    AND horario = ?
    LIMIT 1
`).get(
    data,
    horario
);

if (bloqueado) {
    return false;
}

return true;

    });


    res.json({
        data,
        horarios: horariosDisponiveis
    });

});


/*
 * RESERVA TEMPORÃRIA
 */

app.post("/api/reservar-temporariamente", async (req, res) => {

   const {
    data,
    horario,
    nome,
    cpf,
    whatsapp,
    escaldaPes
} = req.body;


    if (
    !data ||
    !horario ||
    !nome ||
    !cpf ||
    !whatsapp
) {

        return res.status(400).json({
            erro: "Nome, cpf, WhatsApp, data e horÃ¡rio sÃ£o obrigatÃ³rios."
        });

    }


    limparReservasTemporarias();


    /*
     * Verifica reserva confirmada
     */

    const confirmada = db.prepare(`
        SELECT id
        FROM reservas
        WHERE data = ?
          AND horario = ?
          AND status = 'confirmada'
        LIMIT 1
    `).get(
        data,
        horario
    );


    if (confirmada) {

        return res.status(409).json({
            erro: "Este horÃ¡rio jÃ¡ foi confirmado."
        });

    }


    /*
     * Verifica reserva temporÃ¡ria
     */

    const temporaria = db.prepare(`
        SELECT id
        FROM reservas_temporarias
        WHERE data = ?
          AND horario = ?
          AND expira_em > ?
        LIMIT 1
    `).get(
        data,
        horario,
        Date.now()
    );


    if (temporaria) {

        return res.status(409).json({
            erro: "Este horÃ¡rio estÃ¡ temporariamente reservado."
        });

    }


    /*
     * Calcula valores
     */

    const temEscaldaPes = !!escaldaPes;

    const total =
        temEscaldaPes ? 180 : 150;


    /*
     * Reserva por 10 minutos
     */

    const agora = Date.now();

    const expiraEm =
        agora + (10 * 60 * 1000);


    /*
     * GRAVA TODOS OS DADOS
     */

    const resultado = db.prepare(`
        INSERT INTO reservas_temporarias
        (
            data,
            horario,
            nome,
            cpf,
            whatsapp,
            escalda_pes,
            total,
            expira_em,
            criado_em
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        data,
        horario,
        nome,
        cpf,
        whatsapp,
        temEscaldaPes ? 1 : 0,
        total,
        expiraEm,
        new Date().toISOString()
    );

const cpfLimpo = limparDocumento(cpf);
const whatsappLimpo = limparDocumento(whatsapp);

const clienteAsaas = await asaasRequest("/customers", {
    method: "POST",
    body: JSON.stringify({
        name: nome,
        cpfCnpj: cpfLimpo,
        mobilePhone: whatsappLimpo,
        externalReference: `OXUMARE-TEMP-${Number(resultado.lastInsertRowid)}`
    })
});

db.prepare(`
    UPDATE reservas_temporarias
    SET asaas_customer_id = ?
    WHERE id = ?
`).run(
    clienteAsaas.id,
    Number(resultado.lastInsertRowid)
);

const pagamentoAsaas = await asaasRequest("/payments", {
    method: "POST",
    body: JSON.stringify({
        customer: clienteAsaas.id,
        billingType: "PIX",
        value: 50,
        dueDate: dataHojeSaoPaulo(),
        description: `Reserva OxumarÃ© Massagem - ${data} Ã s ${horario}`,
        externalReference: `OXUMARE-TEMP-${Number(resultado.lastInsertRowid)}`
    })
});

db.prepare(`
    UPDATE reservas_temporarias
    SET asaas_payment_id = ?
    WHERE id = ?
`).run(
    pagamentoAsaas.id,
    Number(resultado.lastInsertRowid)
);

const pixAsaas = await asaasRequest(
    `/payments/${pagamentoAsaas.id}/pixQrCode`
);

db.prepare(`
    UPDATE reservas_temporarias
    SET
        pix_payload = ?,
        pix_encoded_image = ?,
        pix_expiration = ?
    WHERE id = ?
`).run(
    pixAsaas.payload,
    pixAsaas.encodedImage,
    pixAsaas.expirationDate,
    Number(resultado.lastInsertRowid)
);
    res.json({
    sucesso: true,
    id: Number(resultado.lastInsertRowid),
    data,
    horario,
    nome,
    whatsapp,
    escaldaPes: temEscaldaPes,
    total,
    reserva: 50,
    restante: total - 50,
    expiraEm,
    paymentId: pagamentoAsaas.id,
    pix: {
        payload: pixAsaas.payload,
        encodedImage: pixAsaas.encodedImage,
        expirationDate: pixAsaas.expirationDate
    }
});

});


/*
 * CONFIRMAR RESERVA
 *
 * Futuramente serÃ¡ chamado pelo webhook
 * do Asaas apÃ³s o pagamento.
 */

app.post("/api/confirmar-reserva", (req, res) => {

    const {
        data,
        horario
    } = req.body;


    if (!data || !horario) {

        return res.status(400).json({
            erro: "Data e horÃ¡rio sÃ£o obrigatÃ³rios."
        });

    }


    /*
     * Procura a reserva temporÃ¡ria
     */

    const temporaria = db.prepare(`
        SELECT *
        FROM reservas_temporarias
        WHERE data = ?
          AND horario = ?
          AND expira_em > ?
        LIMIT 1
    `).get(
        data,
        horario,
        Date.now()
    );


    if (!temporaria) {

        return res.status(404).json({
            erro: "Reserva temporÃ¡ria nÃ£o encontrada ou expirada."
        });

    }


    /*
     * Verifica se jÃ¡ foi confirmada
     */

    const existente = db.prepare(`
        SELECT id
        FROM reservas
        WHERE data = ?
          AND horario = ?
          AND status = 'confirmada'
        LIMIT 1
    `).get(
        data,
        horario
    );


    if (existente) {

        return res.status(409).json({
            erro: "Este horÃ¡rio jÃ¡ estÃ¡ confirmado."
        });

    }


    const total =
        Number(temporaria.total);

    const restante =
        total - 50;


    /*
     * Grava a reserva definitiva
     */

    const resultado = db.prepare(`
        INSERT INTO reservas
        (
            data,
            horario,
            nome,
            whatsapp,
            escalda_pes,
            total,
            reserva,
            restante,
            status,
            criado_em
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        temporaria.data,
        temporaria.horario,
        temporaria.nome,
        temporaria.whatsapp,
        temporaria.escalda_pes,
        total,
        50,
        restante,
        "confirmada",
        new Date().toISOString()
    );


    /*
     * Remove a reserva temporÃ¡ria
     */

    db.prepare(`
        DELETE FROM reservas_temporarias
        WHERE id = ?
    `).run(
        temporaria.id
    );


    res.json({
        sucesso: true,
        id: Number(resultado.lastInsertRowid),
        mensagem: "Reserva confirmada."
    });

});


/*
 * CONSULTAR RESERVAS CONFIRMADAS
 */

// LOGIN DO ADMINISTRADOR
const sessoesAdmin = new Set();

app.post("/api/admin/login", (req, res) => {
    const { senha } = req.body;

    if (!senha || senha !== process.env.ADMIN_PASSWORD) {
        return res.status(401).json({
            erro: "Senha inválida."
        });
    }

    const token = require("node:crypto").randomUUID();

    sessoesAdmin.add(token);

    res.json({
        sucesso: true,
        token
    });
});

function adminAutenticado(req, res, next) {

    const autorizacao =
        req.headers.authorization || "";

    const token =
        autorizacao.startsWith("Bearer ")
            ? autorizacao.substring(7)
            : "";

    if (!token || !sessoesAdmin.has(token)) {
        return res.status(401).json({
            erro: "Acesso não autorizado."
        });
    }

    next();
}

/*
 * BLOQUEAR HORÁRIO
 */
app.post("/api/admin/bloqueios", adminAutenticado, (req, res) => {

    const { data, horario } = req.body;

    if (!data || !horario) {
        return res.status(400).json({
            erro: "Data e horário são obrigatórios."
        });
    }

    try {

        db.prepare(`
            INSERT INTO horarios_bloqueados
            (data, horario, criado_em)
            VALUES (?, ?, ?)
        `).run(
            data,
            horario,
            new Date().toISOString()
        );

        res.json({
            sucesso: true,
            mensagem: "Horário bloqueado com sucesso."
        });

    } catch (erro) {

        if (String(erro.message).includes("UNIQUE")) {
            return res.status(409).json({
                erro: "Este horário já está bloqueado."
            });
        }

        console.error(erro);

        res.status(500).json({
            erro: "Não foi possível bloquear o horário."
        });
    }
});


/*
 * LISTAR HORÁRIOS BLOQUEADOS
 */
app.get("/api/admin/bloqueios", adminAutenticado, (req, res) => {

    const bloqueios = db.prepare(`
        SELECT id, data, horario, criado_em
        FROM horarios_bloqueados
        ORDER BY data ASC, horario ASC
    `).all();

    res.json(bloqueios);
});


/*
 * LIBERAR HORÁRIO
 */
app.delete("/api/admin/bloqueios/:id", adminAutenticado, (req, res) => {

    const id = Number(req.params.id);

    if (!id) {
        return res.status(400).json({
            erro: "ID inválido."
        });
    }

    const resultado = db.prepare(`
        DELETE FROM horarios_bloqueados
        WHERE id = ?
    `).run(id);

    if (resultado.changes === 0) {
        return res.status(404).json({
            erro: "Bloqueio não encontrado."
        });
    }

    res.json({
        sucesso: true,
        mensagem: "Horário liberado com sucesso."
    });
});

app.get("/api/reservas", adminAutenticado, (req, res) => {

    const reservas = db.prepare(`
        SELECT
            id,
            data,
            horario,
            nome,
            whatsapp,
            escalda_pes AS escaldaPes,
            total,
            reserva,
            restante,
            status,
            criado_em AS criadoEm
        FROM reservas
        ORDER BY data ASC, horario ASC
    `).all();


    res.json(reservas);

});


/*
 * CONSULTAR RESERVAS TEMPORÃRIAS
 *
 * Usaremos isso durante os testes e depois
 * no painel administrativo.
 */

app.get("/api/reservas-temporarias", (req, res) => {

    limparReservasTemporarias();

    const reservas = db.prepare(`
        SELECT
            id,
            data,
            horario,
            nome,
            whatsapp,
            escalda_pes AS escaldaPes,
            total,
            expira_em AS expiraEm,
            criado_em AS criadoEm
        FROM reservas_temporarias
        ORDER BY data ASC, horario ASC
    `).all();


    res.json(reservas);

});
/*
 * WEBHOOK ASAAS
 * Recebe a confirmaÃ§Ã£o de pagamento
 */

db.exec(`
    CREATE TABLE IF NOT EXISTS asaas_eventos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        asaas_event_id TEXT UNIQUE NOT NULL,
        evento TEXT NOT NULL,
        recebido_em TEXT NOT NULL
    )
`);

// STATUS DO PAGAMENTO PARA O CLIENTE
app.get("/api/status-pagamento/:paymentId", (req, res) => {
    try {
        const paymentId = req.params.paymentId;

        const reserva = db.prepare(`
            SELECT
                id,
                data,
                horario,
                nome,
                whatsapp,
                escalda_pes,
                total,
                asaas_payment_id
            FROM reservas
            WHERE asaas_payment_id = ?
            LIMIT 1
        `).get(paymentId);

        if (reserva) {
            return res.json({
                status: "CONFIRMADO",
                reserva
            });
        }

        const temporaria = db.prepare(`
            SELECT
                id,
                data,
                horario,
                nome,
                escalda_pes,
                total,
                expira_em,
                asaas_payment_id
            FROM reservas_temporarias
            WHERE asaas_payment_id = ?
            LIMIT 1
        `).get(paymentId);

        if (!temporaria) {
            return res.json({
                status: "NAO_ENCONTRADO"
            });
        }

        if (temporaria.expira_em <= Date.now()) {
            return res.json({
                status: "EXPIRADO"
            });
        }

        return res.json({
            status: "AGUARDANDO_PAGAMENTO",
            reserva: temporaria
        });

    } catch (erro) {
        console.error("Erro ao consultar status do pagamento:", erro);
        return res.status(500).json({
            erro: "Erro ao consultar pagamento"
        });
    }
});

app.post("/api/webhook/asaas", (req, res) => {

    const tokenRecebido =
        req.headers["asaas-access-token"];

    if (
        !ASAAS_WEBHOOK_TOKEN ||
        tokenRecebido !== ASAAS_WEBHOOK_TOKEN
    ) {
        console.log("Webhook Asaas recusado: token invÃ¡lido.");

        return res
            .status(401)
            .json({ erro: "NÃ£o autorizado" });
    }

    const evento = req.body;

    if (!evento || !evento.id) {
        return res
            .status(400)
            .json({ erro: "Evento invÃ¡lido" });
    }

    try {

        db.prepare(`
            INSERT INTO asaas_eventos (
                asaas_event_id,
                evento,
                recebido_em
            )
            VALUES (?, ?, ?)
        `).run(
            evento.id,
            evento.event || "DESCONHECIDO",
            new Date().toISOString()
        );

    } catch (erro) {

        if (
            String(erro.message)
            .includes("UNIQUE constraint failed")
        ) {
            console.log(
                "Evento Asaas jÃ¡ processado:",
                evento.id
            );

            return res.json({
                recebido: true,
                duplicado: true
            });
        }

        console.error(
            "Erro ao registrar evento Asaas:",
            erro
        );

        return res
            .status(500)
            .json({ erro: "Erro interno" });
    }

    console.log(
        "Webhook Asaas recebido:",
        evento.event,
        evento.payment?.id || ""
    );

   if (evento.event === "PAYMENT_RECEIVED") {

    const paymentId =
        evento.payment?.id;

    console.log(
        "Pagamento recebido:",
        paymentId
    );

    if (!paymentId) {

        console.log(
            "Webhook sem payment.id."
        );

    } else {

        const reservaTemporaria =
    db.prepare(`
        SELECT *
        FROM reservas_temporarias
        WHERE asaas_payment_id = ?

        LIMIT 1
    `).get(
        paymentId

    );

        if (!reservaTemporaria) {

            console.log(
                "Nenhuma reserva temporÃ¡ria encontrada para o pagamento:",
                paymentId
            );

        } else {

            const reservaExistente =
                db.prepare(`
                    SELECT *
                    FROM reservas
                    WHERE data = ?
                    AND horario = ?
                    LIMIT 1
                `).get(
                    reservaTemporaria.data,
                    reservaTemporaria.horario
                );

            if (reservaExistente) {

                console.log(
                    "HorÃ¡rio jÃ¡ possui uma reserva confirmada:",
                    reservaTemporaria.data,
                    reservaTemporaria.horario
                );

            } else {

                db.prepare(`
                    INSERT INTO reservas (
                        data,
                        horario,
                        nome,
                        cpf,
                        whatsapp,
                        escalda_pes,
                        total,
                        reserva,
                        restante,
                        status,
                        criado_em,
                        asaas_payment_id
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `).run(
                    reservaTemporaria.data,
                    reservaTemporaria.horario,
                    reservaTemporaria.nome,
                    reservaTemporaria.cpf,
                    reservaTemporaria.whatsapp,
                    reservaTemporaria.escalda_pes,
                    reservaTemporaria.total,
                    50,
                    reservaTemporaria.total - 50,
                    "confirmada",
                    new Date().toISOString(),
                    paymentId
                );

                db.prepare(`
                    DELETE FROM reservas_temporarias
                    WHERE id = ?
                `).run(
                    reservaTemporaria.id
                );

                console.log(
                    "RESERVA CONFIRMADA COM SUCESSO:",
                    reservaTemporaria.data,
                    reservaTemporaria.horario
                );
            }
        }
    }
}

    return res.json({
        recebido: true
    });
});

/*
 * INICIAR SERVIDOR
 */

const servidor = app.listen(PORT, () => {

    console.log(
        `OxumarÃ© Massagem rodando em http://localhost:${PORT}`
    );

    console.log(
        "Banco de dados: oxumare.db"
    );

});

servidor.on("error", (erro) => {
    console.error("ERRO NO SERVIDOR:", erro);
});

setInterval(() => {}, 1000);
