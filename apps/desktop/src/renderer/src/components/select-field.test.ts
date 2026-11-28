import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SelectField } from "./select-field";
import NetworkServicePicker from "./NetworkServicePicker";
const visibleText = (markup: string) => markup.replace(/<[^>]*>/g, "");
describe("网络选择控件的用户可见状态（SSR 回归，不替代 Mac UI 验收）", () => {
  it("空选项显示提示并禁用，不暴露内部 sentinel", () => {
    const markup = renderToStaticMarkup(
      createElement(SelectField, {
        value: "",
        children: [],
        placeholder: "请选择网络服务",
      }),
    );
    expect(visibleText(markup)).toContain("请选择网络服务");
    expect(visibleText(markup)).not.toContain("__gungun_empty_option__");
    expect(markup).toContain("disabled");
  });
  it("已保存但已不存在的服务不显示内部 ID", () => {
    const text = visibleText(
      renderToStaticMarkup(
        createElement(SelectField, {
          value: "gone-service-id",
          children: [
            createElement("option", { key: "wifi", value: "wifi" }, "Wi-Fi"),
          ],
        }),
      ),
    );
    expect(text).toContain("请选择");
    expect(text).not.toContain("gone-service-id");
  });
  it("保留合法的无服务 / 自动选择标签", () => {
    const text = visibleText(
      renderToStaticMarkup(
        createElement(SelectField, {
          value: "",
          children: createElement(
            "option",
            { value: "" },
            "每次开启时选择活动服务",
          ),
        }),
      ),
    );
    expect(text).toContain("每次开启时选择活动服务");
    expect(text).not.toContain("__gungun_empty_option__");
  });
  it("读取失败显示明确错误，不伪装为未发现网络", () => {
    const markup = renderToStaticMarkup(
      createElement(NetworkServicePicker, {
        services: [],
        loading: false,
        error: "系统读取被拒绝",
        value: "",
        onValueChange: () => {},
      }),
    );
    const text = visibleText(markup);
    expect(text).toContain("读取网络服务失败：系统读取被拒绝");
    expect(text).not.toContain("未发现已启用");
    expect(text).not.toContain("__gungun_empty_option__");
    expect(markup).toContain('role="alert"');
  });
  it("加载与真实空列表分别提示，均不显示内部占位符", () => {
    const props = {
      services: [],
      value: "",
      onValueChange: () => {},
      error: "",
    };
    const loading = visibleText(
      renderToStaticMarkup(
        createElement(NetworkServicePicker, { ...props, loading: true }),
      ),
    );
    const empty = visibleText(
      renderToStaticMarkup(
        createElement(NetworkServicePicker, { ...props, loading: false }),
      ),
    );
    expect(loading).toContain("正在读取本机网络服务");
    expect(loading).not.toContain("未发现已启用");
    expect(empty).toContain("未发现已启用的网络服务");
  });
});
