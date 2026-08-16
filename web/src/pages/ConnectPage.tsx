import { Button } from "../bflabs/Button";
import { Notice } from "../bflabs/Notice";
import { Tabs } from "../bflabs/Tabs";
import { RECIPE_ORDER, type RecipeName } from "../recipes";
import { PageFrame } from "./shared";

const RECIPE_LABEL: Record<RecipeName, string> = {
  claude: "Claude Code",
  grok: "Grok Build",
  openai: "OpenAI SDK",
  newapi: "new-api",
};

export function ConnectPage({
  t,
  origin,
  copied,
  recipe,
  snippets,
  routes,
  onCopy,
  onRecipe,
}: {
  t: {
    title: string;
    origin: string;
    copy: string;
    copied: string;
    recipes: string;
    routeTitle: string;
    routeClient: string;
    routeEndpoint: string;
    routeNote: string;
    workspaceTitle: string;
    workspaceBody: string;
  };
  origin: string;
  copied: string;
  recipe: RecipeName;
  snippets: Record<RecipeName, string>;
  routes: Array<{ client: string; endpoint: string; note: string }>;
  onCopy: (label: string, value: string) => void;
  onRecipe: (value: RecipeName) => void;
}) {
  return (
    <PageFrame title={t.title}>
      <div className="home-origin">
        <div>
          <p className="kicker">{t.origin}</p>
          <p className="origin mono">{origin}</p>
        </div>
        <Button variant="secondary" size="sm" data-copied={copied === "origin" ? "true" : undefined} onClick={() => onCopy("origin", origin)}>{copied === "origin" ? t.copied : t.copy}</Button>
      </div>
      <ul className="endpoints page-endpoints">
        <li><span>POST</span><code>/v1/messages</code></li>
        <li><span>POST</span><code>/v1/chat/completions</code></li>
        <li><span>POST</span><code>/v1/responses</code></li>
        <li><span>GET</span><code>/v1/models</code></li>
        <li><span>GET</span><code>/v1/account</code></li>
      </ul>
      <h2 className="subhead">{t.routeTitle}</h2>
      <table className="route-map">
        <thead>
          <tr>
            <th>{t.routeClient}</th>
            <th>{t.routeEndpoint}</th>
            <th>{t.routeNote}</th>
          </tr>
        </thead>
        <tbody>
          {routes.map((row) => (
            <tr key={row.client}>
              <th scope="row">{row.client}</th>
              <td><code>{row.endpoint}</code></td>
              <td>{row.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <Notice title={t.workspaceTitle} description={t.workspaceBody} />
      <h2 className="subhead">{t.recipes}</h2>
      <Tabs
        label={t.recipes}
        value={recipe}
        onValueChange={(value) => onRecipe(value as RecipeName)}
        items={RECIPE_ORDER.map((name) => ({
          value: name,
          label: RECIPE_LABEL[name],
          content: (
            <div>
              <div className="recipe-tools">
                <Button variant="secondary" size="sm" data-copied={copied === "recipe" ? "true" : undefined} onClick={() => onCopy("recipe", snippets[name])}>
                  {copied === "recipe" ? t.copied : t.copy}
                </Button>
              </div>
              <pre className="snip">{snippets[name]}</pre>
            </div>
          ),
        }))}
      />
    </PageFrame>
  );
}
