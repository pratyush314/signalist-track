import { getNews } from "../actions/finnhub.actions";
import { getAllUsersForNewsEmail } from "../actions/user.action";
import { getWatchlistSymbolsByEmail } from "../actions/watchlist.action";
import { sendNewsSummaryEmail, sendWelcomeEmail } from "../nodemailer";
import { formatDateToday } from "../utils";
import { inngest } from "./client";
import {
  NEWS_SUMMARY_EMAIL_PROMPT,
  PERSONALIZED_WELCOME_EMAIL_PROMPT,
} from "./prompts";

export const sendSignUpEmail = inngest.createFunction(
  { id: "sign-up-email" },
  { event: "app/user.created" },
  async ({ event, step }) => {
    const userProfile = ` 
    - Country: ${event.data.country}
    - Investment goals: ${event.data.investmentGoals}
    - Risk tolerance: ${event.data.investmentGoals}
    - Preferred industry: ${event.data.preferredIndustry}
    `;

    const prompt = PERSONALIZED_WELCOME_EMAIL_PROMPT.replace(
      "{{userProfile}}",
      userProfile
    );
    const response = await step.ai.infer("generate-welcome-intro", {
      model: step.ai.models.gemini({
        model: "gemini-2.5-flash-lite-preview-06-17",
      }),
      body: {
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }],
          },
        ],
      },
    });
    await step.run("send-welcome-email", async () => {
      const part = response.candidates?.[0].content.parts?.[0];
      const introText =
        (part && "text" in part ? part.text : null) ||
        "Thanks for joining Signalist. You now have the tools to track markets and make smarter moves.";
      const {
        data: { email, name },
      } = event;
      return await sendWelcomeEmail({
        email,
        name,
        intro: introText,
      });
    });

    return {
      success: true,
      message: "Welcome email sent successfully !",
    };
  }
);

export const sendDailyNewsSummary = inngest.createFunction(
  {
    id: "daily-news-summary",
  },
  [{ event: "app/send.daily.news" }, { cron: "0 12 * * *" }],
  async ({ step }) => {
    const users = await step.run("get-all-users", getAllUsersForNewsEmail);
    if (!users || users.length === 0)
      return { success: false, message: "No users found for news email" };
    const results = await step.run("fetch-user-news", async () => {
      const perUser: Array<{
        user: UserForNewsEmail;
        articles: MarketNewsArticle[];
      }> = [];
      for (const user of users as UserForNewsEmail[]) {
        try {
          const symbols = await getWatchlistSymbolsByEmail(user.email);
          let articles = await getNews(symbols);
          articles = (articles || []).slice(0, 6);
          if (!articles || articles.length === 0) {
            articles = await getNews();
            articles = (articles || []).slice(0, 6);
          }
          perUser.push({ user, articles });
        } catch (error) {
          console.log(error);
          perUser.push({ user, articles: [] });
        }
      }
      return perUser;
    });

    const userNewsSummaries: { user: User; newsContent: string | null }[] = [];
    for (const { user, articles } of results) {
      try {
        const prompt = NEWS_SUMMARY_EMAIL_PROMPT.replace(
          "{{newsData}}",
          JSON.stringify(articles, null, 2)
        );

        const response = await step.ai.infer(`summarize-news-${user.email}`, {
          model: step.ai.models.gemini({
            model: "gemini-2.5-flash-lite-preview-06-17",
          }),
          body: {
            contents: [{ role: "user", parts: [{ text: prompt }] }],
          },
        });
        const part = response.candidates?.[0]?.content?.parts?.[0];
        const newsContent =
          (part && "text" in part ? part.text : null) || "No market news.";
        userNewsSummaries.push({ user, newsContent });
      } catch (error) {
        console.log("Failed to summarize news for :", error);
        userNewsSummaries.push({ user, newsContent: null });
      }
    }

    await step.run("send-news-emails", async () => {
      await Promise.all(
        userNewsSummaries.map(async ({ user, newsContent }) => {
          if (!newsContent) return false;
          const { getFormattedTodayDate } = await import("../utils");
          return await sendNewsSummaryEmail({
            email: user.email,
            date: getFormattedTodayDate(),
            newsContent,
          });
        })
      );
    });
    return {
      success: true,
      message: "Daily news summary emails sent successfully !",
    };
  }
);
