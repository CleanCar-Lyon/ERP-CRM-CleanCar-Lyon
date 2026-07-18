const {onRequest} = require("firebase-functions/v2/https");
const {defineSecret} = require("firebase-functions/params");
const admin = require("firebase-admin");
const logger = require("firebase-functions/logger");

admin.initializeApp();
const db = admin.firestore();
const STRIPE_SECRET = defineSecret("STRIPE_SECRET");
const STRIPE_WEBHOOK_SECRET = defineSecret("STRIPE_WEBHOOK_SECRET");

const PRICE_IDS = {
  basic: {
    monthly: "price_1Tfp6IEH7rZPN8slCifDc1DC",
    annual: "price_1TfpHhEH7rZPN8slcggSh0Sb"
  },
  pro: {
    monthly: "price_1TfpM9EH7rZPN8sl7ZX90zy7",
    annual: "price_1TfpL7EH7rZPN8sl0OEXss3z"
  },
  proplus: {
    monthly: "price_1TfpPZEH7rZPN8slml12rS3f",
    annual: "price_1TfjgtEH7rZPN8slphKQH5Ds"
  }
};

// ═══════════════════════════════════════
// STRIPE CHECKOUT SESSION
// ═══════════════════════════════════════
exports.createCheckoutSession = onRequest(
  {secrets: ["STRIPE_SECRET"], cors: true},
  async (req, res) => {
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");
    const stripe = require("stripe")(STRIPE_SECRET.value());
    const {email, plan, billing, uid, successUrl, cancelUrl} = req.body;
    if (!email || !plan || !uid) {
      return res.status(400).json({error: "Paramètres manquants"});
    }
    try {
      const priceId = PRICE_IDS[plan]?.[billing === "annual" ? "annual" : "monthly"];
      if (!priceId) return res.status(400).json({error: "Plan invalide"});
      let customerId;
      const snap = await db.collection("users_profiles").doc(uid).get();
      const userData = snap.data() || {};
      if (userData.stripeCustomerId) {
        customerId = userData.stripeCustomerId;
      } else {
        const customer = await stripe.customers.create({email, metadata: {uid}});
        customerId = customer.id;
        await db.collection("users_profiles").doc(uid).update({stripeCustomerId: customerId});
      }
      const session = await stripe.checkout.sessions.create({
        customer: customerId,
        payment_method_types: ["card"],
        mode: "subscription",
        line_items: [{price: priceId, quantity: 1}],
        subscription_data: {
          trial_period_days: 14,
          metadata: {uid, plan, billing: billing || "monthly"}
        },
        success_url: successUrl + "?session_id={CHECKOUT_SESSION_ID}&plan=" + plan,
        cancel_url: cancelUrl,
        locale: "fr",
        allow_promotion_codes: true,
        metadata: {uid, plan, billing: billing || "monthly"}
      });
      res.json({url: session.url, sessionId: session.id});
    } catch (err) {
      logger.error("createCheckoutSession error", err);
      res.status(500).json({error: err.message});
    }
  }
);

// ═══════════════════════════════════════
// STRIPE CUSTOMER PORTAL
// ═══════════════════════════════════════
exports.createPortalSession = onRequest(
  {secrets: ["STRIPE_SECRET"], cors: true},
  async (req, res) => {
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");
    const stripe = require("stripe")(STRIPE_SECRET.value());
    const {uid, returnUrl} = req.body;
    if (!uid) return res.status(400).json({error: "UID manquant"});
    try {
      const snap = await db.collection("users_profiles").doc(uid).get();
      const {stripeCustomerId} = snap.data() || {};
      if (!stripeCustomerId) return res.status(404).json({error: "Aucun abonnement trouvé"});
      const session = await stripe.billingPortal.sessions.create({
        customer: stripeCustomerId,
        return_url: returnUrl
      });
      res.json({url: session.url});
    } catch (err) {
      logger.error("createPortalSession error", err);
      res.status(500).json({error: err.message});
    }
  }
);

// ═══════════════════════════════════════
// WEBHOOK STRIPE → FIREBASE
// ═══════════════════════════════════════
exports.stripeWebhook = onRequest(
  {secrets: ["STRIPE_SECRET", "STRIPE_WEBHOOK_SECRET"], rawBody: true, cors: false},
  async (req, res) => {
    const stripe = require("stripe")(STRIPE_SECRET.value());
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.rawBody,
        req.headers["stripe-signature"],
        STRIPE_WEBHOOK_SECRET.value()
      );
    } catch (err) {
      logger.error("Webhook signature error", err);
      return res.status(400).send("Webhook Error");
    }
    const obj = event.data.object;
    let uid = obj.metadata?.uid;
    if (!uid && obj.subscription) {
      try {
        const sub = await stripe.subscriptions.retrieve(obj.subscription);
        uid = sub.metadata?.uid;
      } catch(e) {}
    }
    if (!uid) return res.json({received: true});
    try {
      switch (event.type) {
        case "checkout.session.completed":
          await db.collection("users_profiles").doc(uid).update({
            plan: obj.metadata?.plan || "basic",
            billing: obj.metadata?.billing || "monthly",
            subscriptionStatus: "trialing",
            updatedAt: new Date().toISOString()
          });
          break;
        case "customer.subscription.updated":
        case "customer.subscription.created":
          await db.collection("users_profiles").doc(uid).update({
            plan: obj.metadata?.plan || "basic",
            billing: obj.metadata?.billing || "monthly",
            stripeSubscriptionId: obj.id,
            subscriptionStatus: obj.status,
            expiresAt: obj.current_period_end
              ? new Date(obj.current_period_end * 1000).toISOString() : null,
            updatedAt: new Date().toISOString()
          });
          break;
        case "customer.subscription.deleted":
          await db.collection("users_profiles").doc(uid).update({
            plan: "starter",
            subscriptionStatus: "canceled",
            expiresAt: null,
            updatedAt: new Date().toISOString()
          });
          break;
        case "invoice.payment_failed":
          await db.collection("users_profiles").doc(uid).update({
            subscriptionStatus: "past_due",
            updatedAt: new Date().toISOString()
          });
          break;
        case "customer.subscription.trial_will_end":
          logger.info("Trial ending soon for uid:", uid);
          break;
      }
      res.json({received: true});
    } catch (err) {
      logger.error("Webhook processing error", err);
      res.status(500).json({error: err.message});
    }
  }
);

// ═══════════════════════════════════════
// ANNULER UN ABONNEMENT
// ═══════════════════════════════════════
exports.cancelSubscription = onRequest(
  {secrets: ["STRIPE_SECRET"], cors: true},
  async (req, res) => {
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");
    const stripe = require("stripe")(STRIPE_SECRET.value());
    const {uid} = req.body;
    if (!uid) return res.status(400).json({error: "UID manquant"});
    try {
      const snap = await db.collection("users_profiles").doc(uid).get();
      const {stripeSubscriptionId} = snap.data() || {};
      if (!stripeSubscriptionId) return res.status(404).json({error: "Abonnement introuvable"});
      await stripe.subscriptions.update(stripeSubscriptionId, {cancel_at_period_end: true});
      await db.collection("users_profiles").doc(uid).update({
        subscriptionStatus: "canceling",
        updatedAt: new Date().toISOString()
      });
      res.json({success: true});
    } catch (err) {
      logger.error("cancelSubscription error", err);
      res.status(500).json({error: err.message});
    }
  }
);

// ═══════════════════════════════════════
// STRIPE CONNECT — CRÉER UN COMPTE
// ═══════════════════════════════════════
exports.createConnectAccount = onRequest(
  {secrets: ["STRIPE_SECRET"], cors: true},
  async (req, res) => {
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");
    const stripe = require("stripe")(STRIPE_SECRET.value());
    const {uid, email, returnUrl, refreshUrl} = req.body;
    if (!uid || !email) return res.status(400).json({error: "Paramètres manquants"});
    try {
      // Vérifier si un compte Connect existe déjà
      const snap = await db.collection("users_profiles").doc(uid).get();
      const userData = snap.data() || {};
      let accountId = userData.stripeConnectAccountId;

      if (!accountId) {
        // Créer un nouveau compte Connect Express
        const account = await stripe.accounts.create({
          type: "express",
          email,
          country: "FR",
          capabilities: {card_payments: {requested: true}, transfers: {requested: true}},
          business_type: "individual",
          metadata: {uid}
        });
        accountId = account.id;
        await db.collection("users_profiles").doc(uid).update({
          stripeConnectAccountId: accountId,
          stripeConnectStatus: "pending",
          updatedAt: new Date().toISOString()
        });
      }

      // Créer le lien d'onboarding
      const accountLink = await stripe.accountLinks.create({
        account: accountId,
        refresh_url: refreshUrl,
        return_url: returnUrl,
        type: "account_onboarding"
      });
      res.json({url: accountLink.url});
    } catch (err) {
      logger.error("createConnectAccount error", err);
      res.status(500).json({error: err.message});
    }
  }
);

// ═══════════════════════════════════════
// STRIPE CONNECT — VÉRIFIER STATUT
// ═══════════════════════════════════════
exports.checkConnectStatus = onRequest(
  {secrets: ["STRIPE_SECRET"], cors: true},
  async (req, res) => {
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");
    const stripe = require("stripe")(STRIPE_SECRET.value());
    const {uid} = req.body;
    if (!uid) return res.status(400).json({error: "UID manquant"});
    try {
      const snap = await db.collection("users_profiles").doc(uid).get();
      const {stripeConnectAccountId} = snap.data() || {};
      if (!stripeConnectAccountId) return res.json({status: "not_connected"});

      const account = await stripe.accounts.retrieve(stripeConnectAccountId);
      const isActive = account.charges_enabled && account.payouts_enabled;
      const status = isActive ? "active" : "pending";

      // Mettre à jour Firestore
      await db.collection("users_profiles").doc(uid).update({
        stripeConnectStatus: status,
        updatedAt: new Date().toISOString()
      });
      res.json({status, accountId: stripeConnectAccountId});
    } catch (err) {
      logger.error("checkConnectStatus error", err);
      res.status(500).json({error: err.message});
    }
  }
);

// ═══════════════════════════════════════
// STRIPE CONNECT — PAIEMENT PAGE RÉSERVATION
// ═══════════════════════════════════════
exports.createConnectPayment = onRequest(
  {secrets: ["STRIPE_SECRET"], cors: true},
  async (req, res) => {
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");
    const stripe = require("stripe")(STRIPE_SECRET.value());
    const {uid, amount, description, successUrl, cancelUrl} = req.body;
    if (!uid || !amount) return res.status(400).json({error: "Paramètres manquants"});
    try {
      // Récupérer le compte Connect du prestataire
      const snap = await db.collection("users_profiles").doc(uid).get();
      const {stripeConnectAccountId} = snap.data() || {};
      if (!stripeConnectAccountId) return res.status(400).json({error: "Compte Stripe non connecté"});

      // Créer la session de paiement sur le compte Connect
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        line_items: [{
          price_data: {
            currency: "eur",
            product_data: {name: description || "Prestation lavage auto"},
            unit_amount: Math.round(amount * 100), // en centimes
          },
          quantity: 1,
        }],
        mode: "payment",
        success_url: successUrl,
        cancel_url: cancelUrl,
        payment_intent_data: {
          application_fee_amount: Math.round(amount * 100 * 0.02), // 2% commission WashDesk
          transfer_data: {destination: stripeConnectAccountId},
        },
      });
      res.json({url: session.url});
    } catch (err) {
      logger.error("createConnectPayment error", err);
      res.status(500).json({error: err.message});
    }
  }
);


// ═══════════════════════════════════════
// EMAIL — RESEND
// ═══════════════════════════════════════
const {onDocumentCreated, onDocumentUpdated} = require("firebase-functions/v2/firestore");
const RESEND_API_KEY = defineSecret("RESEND_API_KEY");

const FROM_EMAIL = "contact@washdesk.fr";
const FROM_NAME = "WashDesk";

async function sendEmail(apiKey, {to, subject, html}) {
  const {Resend} = require("resend");
  const resend = new Resend(apiKey);
  try {
    const result = await resend.emails.send({
      from: `${FROM_NAME} <${FROM_EMAIL}>`,
      to, subject, html
    });
    logger.info("Email envoyé:", result);
    return result;
  } catch(e) {
    logger.error("Erreur email:", e);
    throw e;
  }
}

function emailLayout(content) {
  return `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{margin:0;padding:0;box-sizing:border-box;}
body{font-family:'Helvetica Neue',Arial,sans-serif;background:#f0f3f8;color:#13203D;}
.wrap{max-width:600px;margin:0 auto;padding:32px 16px;}
.card{background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(19,32,61,.08);}
.header{background:#13203D;padding:28px 32px;text-align:center;}
.logo{font-size:1.5rem;font-weight:800;color:#ffffff;letter-spacing:-0.5px;}
.logo span{color:rgba(255,255,255,.5);}
.body{padding:32px;}
.title{font-size:1.3rem;font-weight:700;color:#13203D;margin-bottom:12px;}
.text{font-size:.92rem;color:#4a5568;line-height:1.7;margin-bottom:16px;}
.btn{display:inline-block;background:#13203D;color:#ffffff!important;text-decoration:none;padding:13px 28px;border-radius:10px;font-weight:700;font-size:.92rem;margin:8px 0;}
.highlight{background:#f0f3f8;border-radius:10px;padding:16px 20px;margin:16px 0;}
.highlight strong{color:#13203D;}
.divider{height:1px;background:#e8edf5;margin:20px 0;}
.footer{background:#f8f9fc;padding:20px 32px;text-align:center;border-top:1px solid #e8edf5;}
.footer p{font-size:.75rem;color:#8892a4;line-height:1.6;}
.footer a{color:#13203D;text-decoration:none;}
</style>
</head>
<body>
<div class="wrap">
<div class="card">
<div class="header"><div class="logo">Wash<span>Desk</span></div></div>
<div class="body">${content}</div>
<div class="footer">
<p>WashDesk — Le logiciel des pros du lavage auto<br>
<a href="https://washdesk.fr">washdesk.fr</a> · <a href="mailto:contact@washdesk.fr">contact@washdesk.fr</a></p>
<p style="margin-top:8px;">Vous recevez cet email car vous êtes inscrit sur WashDesk.</p>
</div>
</div>
</div>
</body>
</html>`;
}

const PLAN_NAMES = {starter:"Starter", basic:"Basic", pro:"Pro ⭐", proplus:"Pro+ 🚀"};
const PLAN_PRICES = {basic:"14,99€/mois", pro:"24,99€/mois", proplus:"34,99€/mois"};
const PLAN_FEATURES = {
  basic: "50 clients · 100 prestations · 20 devis · 50 factures · Agenda & Planning",
  pro: "Illimité · Agenda · Statistiques · Comptabilité · Marketing email/SMS",
  proplus: "Tout du Pro + Page de réservation en ligne avec paiement Stripe"
};

// ═══════════════════════════════════════
// 1. EMAIL DE BIENVENUE
// Déclencheur : création d'un profil utilisateur
// ═══════════════════════════════════════
exports.sendWelcomeEmail = onDocumentCreated(
  {document: "users_profiles/{uid}", secrets: ["RESEND_API_KEY"]},
  async (event) => {
    const data = event.data?.data();
    if (!data?.email) return;
    const prenom = data.prenom || data.nomEntreprise || "là";
    const tpl = await getEmailTemplate("welcome");
    if (!tpl) return;
    const subject = applyVars(tpl.subject, {prenom});
    const html = emailLayout(applyVars(tpl.body, {prenom}));
    await sendEmail(RESEND_API_KEY.value(), {to: data.email, subject, html});
    logger.info("Email bienvenue envoyé à", data.email);
  }
);

// ═══════════════════════════════════════
// 2. CONFIRMATION D'ABONNEMENT
// Déclencheur : changement de plan vers payant
// ═══════════════════════════════════════
exports.sendSubscriptionConfirmEmail = onDocumentUpdated(
  {document: "users_profiles/{uid}", secrets: ["RESEND_API_KEY"]},
  async (event) => {
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();
    if (!after?.email) return;

    const planBefore = before?.plan || "starter";
    const planAfter = after?.plan || "starter";

    // Email confirmation abonnement : plan avant = starter/free, plan après = payant
    if (planBefore === planAfter) return;
    if (!["basic","pro","proplus"].includes(planAfter)) return;
    // Ne pas envoyer si c'est une résiliation (géré ailleurs)
    if (["starter","free"].includes(planAfter)) return;

    const prenom = after.prenom || after.nomEntreprise || "là";
    const planName = PLAN_NAMES[planAfter] || planAfter;
    const planPrice = PLAN_PRICES[planAfter] || "";
    const planFeature = PLAN_FEATURES[planAfter] || "";
    const expiresAt = after.expiresAt
      ? new Date(after.expiresAt).toLocaleDateString("fr-FR", {day:"numeric", month:"long", year:"numeric"})
      : null;

    const tpl = await getEmailTemplate("subscription");
    if (!tpl) return;
    const vars = {
      prenom, plan: planName, prix: planPrice,
      fonctionnalites: planFeature,
      expiration: expiresAt ? `<strong>Valide jusqu'au :</strong> ${expiresAt}<br>` : ""
    };
    const subject = applyVars(tpl.subject, vars);
    const html = emailLayout(applyVars(tpl.body, vars));
    await sendEmail(RESEND_API_KEY.value(), {to: after.email, subject, html});
    logger.info("Email confirmation abonnement envoyé à", after.email);
  }
);

// ═══════════════════════════════════════
// 3. EXPIRATION ESSAI GRATUIT / ABONNEMENT
// Déclencheur : HTTP (cron job quotidien)
// ═══════════════════════════════════════
exports.sendExpirationReminders = onRequest(
  {secrets: ["RESEND_API_KEY"], cors: false},
  async (req, res) => {
    const token = req.headers["x-cron-token"];
    if (token !== "washdesk-cron-2026") return res.status(401).json({error: "Non autorisé"});

    const now = new Date();
    const snap = await db.collection("users_profiles")
      .where("plan", "in", ["basic","pro","proplus"])
      .get();

    let sent = 0;
    for (const doc of snap.docs) {
      const u = doc.data();
      if (!u.email || !u.expiresAt) continue;
      const exp = new Date(u.expiresAt);
      const daysLeft = Math.ceil((exp - now) / (1000*60*60*24));
      const prenom = u.prenom || u.nomEntreprise || "là";
      const planName = PLAN_NAMES[u.plan] || u.plan;
      const expStr = exp.toLocaleDateString("fr-FR", {day:"numeric", month:"long", year:"numeric"});

      const vars = {prenom, plan: planName, date_expiration: expStr};
      // J-7
      if (daysLeft === 7) {
        const tpl = await getEmailTemplate("expiration_7");
        if (tpl) {
          await sendEmail(RESEND_API_KEY.value(), {
            to: u.email,
            subject: applyVars(tpl.subject, vars),
            html: emailLayout(applyVars(tpl.body, vars))
          });
          sent++;
        }
      }
      // J-1
      else if (daysLeft === 1) {
        const tpl = await getEmailTemplate("expiration_1");
        if (tpl) {
          await sendEmail(RESEND_API_KEY.value(), {
            to: u.email,
            subject: applyVars(tpl.subject, vars),
            html: emailLayout(applyVars(tpl.body, vars))
          });
          sent++;
        }
      }
    }
    res.json({success: true, sent, checked: snap.size});
  }
);

// ═══════════════════════════════════════
// 4. RÉSILIATION D'ABONNEMENT
// Déclencheur : retour au plan starter/free
// ═══════════════════════════════════════
exports.sendCancellationEmail = onDocumentUpdated(
  {document: "users_profiles/{uid}", secrets: ["RESEND_API_KEY"]},
  async (event) => {
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();
    if (!after?.email) return;

    const planBefore = before?.plan || "starter";
    const planAfter = after?.plan || "starter";

    // Résiliation : plan avant = payant, plan après = starter/free
    if (!["basic","pro","proplus"].includes(planBefore)) return;
    if (!["starter","free"].includes(planAfter)) return;

    const prenom = after.prenom || after.nomEntreprise || "là";
    const planName = PLAN_NAMES[planBefore] || planBefore;

    const tpl = await getEmailTemplate("cancellation");
    if (!tpl) return;
    const vars = {prenom, plan: planName};
    const subject = applyVars(tpl.subject, vars);
    const html = emailLayout(applyVars(tpl.body, vars));
    await sendEmail(RESEND_API_KEY.value(), {to: after.email, subject, html});
    logger.info("Email résiliation envoyé à", after.email);
  }
);

// ═══════════════════════════════════════
// EMAIL DEPUIS LE BACK-OFFICE ADMIN
// ═══════════════════════════════════════
exports.sendAdminEmail = onRequest(
  {secrets: ["RESEND_API_KEY"], cors: true},
  async (req, res) => {
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");
    const {to, subject, htmlContent, adminToken} = req.body;
    if (adminToken !== "washdesk-admin-2026") return res.status(401).json({error: "Non autorisé"});
    if (!to || !subject || !htmlContent) return res.status(400).json({error: "Paramètres manquants"});
    try {
      const result = await sendEmail(RESEND_API_KEY.value(), {
        to,
        subject,
        html: emailLayout(htmlContent)
      });
      res.json({success: true, result});
    } catch(e) {
      res.status(500).json({error: e.message});
    }
  }
);

// ═══════════════════════════════════════
// GESTION DES TEMPLATES EMAIL
// ═══════════════════════════════════════

// Templates par défaut (utilisés si Firestore n'a pas de template)
const DEFAULT_TEMPLATES = {
  welcome: {
    subject: "🎉 Bienvenue sur WashDesk, {prenom} !",
    body: `<div class="title">🎉 Bienvenue sur WashDesk, {prenom} !</div>
<p class="text">Votre compte est créé et prêt à l'emploi. Gérez vos clients, prestations, devis et factures depuis une seule application — partout, sur tous vos appareils.</p>
<div class="highlight">
<strong>🚀 Pour bien démarrer :</strong><br><br>
<span style="font-size:.88rem;color:#4a5568;line-height:2;">
1️⃣ Renseignez les infos de votre entreprise<br>
2️⃣ Créez vos formules de lavage<br>
3️⃣ Ajoutez votre premier client<br>
4️⃣ Créez votre première prestation
</span>
</div>
<a href="https://washdesk.fr/dashboard.html" class="btn">Accéder à mon espace WashDesk →</a>
<p class="text" style="margin-top:16px;font-size:.82rem;">Une question ? Répondez directement à cet email 😊</p>`
  },
  subscription: {
    subject: "✅ Abonnement WashDesk {plan} activé !",
    body: `<div class="title">✅ Votre abonnement {plan} est activé !</div>
<p class="text">Bonjour {prenom}, merci pour votre confiance ! Votre plan <strong>{plan}</strong> est maintenant actif.</p>
<div class="highlight">
<strong>📋 Récapitulatif :</strong><br><br>
<span style="font-size:.88rem;color:#4a5568;line-height:2;">
<strong>Plan :</strong> {plan}<br>
<strong>Tarif :</strong> {prix}<br>
{expiration}
<strong>Inclus :</strong> {fonctionnalites}
</span>
</div>
<a href="https://washdesk.fr/dashboard.html" class="btn">Accéder à mon espace →</a>
<p class="text" style="margin-top:16px;font-size:.82rem;">Pour gérer votre abonnement, rendez-vous dans <strong>Mon abonnement → Gérer mon abonnement</strong>.</p>`
  },
  expiration_7: {
    subject: "⏰ Votre abonnement WashDesk expire dans 7 jours",
    body: `<div class="title">⏰ Votre abonnement expire dans 7 jours</div>
<p class="text">Bonjour {prenom}, votre abonnement <strong>{plan}</strong> expire le <strong>{date_expiration}</strong>.</p>
<p class="text">Pour continuer à profiter de toutes vos fonctionnalités sans interruption, renouvelez votre abonnement dès maintenant.</p>
<a href="https://washdesk.fr/dashboard.html" class="btn">Renouveler mon abonnement →</a>
<p class="text" style="margin-top:16px;font-size:.82rem;">Sans renouvellement, votre compte passera en plan Gratuit le {date_expiration}. Vos données seront conservées.</p>`
  },
  expiration_1: {
    subject: "🚨 Dernier jour — votre abonnement WashDesk expire demain",
    body: `<div class="title">🚨 Dernière chance — votre abonnement expire demain !</div>
<p class="text">Bonjour {prenom}, c'est le dernier jour ! Votre abonnement <strong>{plan}</strong> expire demain le <strong>{date_expiration}</strong>.</p>
<a href="https://washdesk.fr/dashboard.html" class="btn">Renouveler maintenant →</a>`
  },
  cancellation: {
    subject: "Résiliation de votre abonnement WashDesk",
    body: `<div class="title">😢 Votre abonnement a été résilié</div>
<p class="text">Bonjour {prenom}, votre abonnement <strong>{plan}</strong> a bien été résilié. Votre compte est maintenant en plan Gratuit.</p>
<div class="highlight">
<strong>📋 Ce qui change :</strong><br><br>
<span style="font-size:.88rem;color:#4a5568;line-height:2;">
✅ Vos données sont conservées<br>
✅ Vous gardez accès à vos données existantes<br>
⚠️ Les fonctionnalités Pro ne sont plus accessibles
</span>
</div>
<a href="https://washdesk.fr/dashboard.html" class="btn">Réactiver mon abonnement →</a>
<p class="text" style="margin-top:16px;font-size:.82rem;">Votre avis nous aide à améliorer WashDesk. Écrivez-nous à <a href="mailto:contact@washdesk.fr" style="color:#13203D;">contact@washdesk.fr</a> 🙏</p>`
  }
};

// Charger un template depuis Firestore (avec fallback sur défaut)
async function getEmailTemplate(type) {
  try {
    const doc = await db.collection("email_templates").doc(type).get();
    if (doc.exists) return doc.data();
  } catch(e) {
    logger.warn("Template non trouvé dans Firestore, utilisation du défaut:", type);
  }
  return DEFAULT_TEMPLATES[type] || null;
}

// Remplacer les variables dans un template
function applyVars(template, vars) {
  let result = template;
  for (const [key, val] of Object.entries(vars)) {
    result = result.replaceAll(`{${key}}`, val || "");
  }
  return result;
}

// Initialiser les templates par défaut dans Firestore
exports.initEmailTemplates = onRequest(
  {cors: true},
  async (req, res) => {
    const token = req.headers["x-admin-token"];
    if (token !== "washdesk-admin-2026") return res.status(401).json({error: "Non autorisé"});
    try {
      const batch = db.batch();
      for (const [type, template] of Object.entries(DEFAULT_TEMPLATES)) {
        const ref = db.collection("email_templates").doc(type);
        batch.set(ref, {...template, updatedAt: new Date().toISOString()}, {merge: true});
      }
      await batch.commit();
      res.json({success: true, templates: Object.keys(DEFAULT_TEMPLATES)});
    } catch(e) {
      res.status(500).json({error: e.message});
    }
  }
);

// Sauvegarder un template depuis le back-office
exports.saveEmailTemplate = onRequest(
  {cors: true},
  async (req, res) => {
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");
    const {type, subject, body, adminToken} = req.body;
    if (adminToken !== "washdesk-admin-2026") return res.status(401).json({error: "Non autorisé"});
    if (!type || !subject || !body) return res.status(400).json({error: "Paramètres manquants"});
    try {
      await db.collection("email_templates").doc(type).set({
        subject, body, updatedAt: new Date().toISOString()
      });
      res.json({success: true});
    } catch(e) {
      res.status(500).json({error: e.message});
    }
  }
);
