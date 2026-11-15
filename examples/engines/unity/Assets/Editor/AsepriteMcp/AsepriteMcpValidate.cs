#if UNITY_EDITOR
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;

namespace AsepriteMcp
{
    public static class Validate
    {
        public static void Run()
        {
            var report = new System.Text.StringBuilder();
            foreach (var guid in AssetDatabase.FindAssets("", new[] { "Assets" }))
            {
                var path = AssetDatabase.GUIDToAssetPath(guid);
                if (!(path.EndsWith(".aseprite") || path.EndsWith(".ase") || path.EndsWith(".png"))) continue;
                var sprites = AssetDatabase.LoadAllAssetsAtPath(path).OfType<Sprite>().Count();
                var clips = AssetDatabase.LoadAllAssetsAtPath(path).OfType<AnimationClip>().Count();
                report.AppendLine($"{path}\tguid={guid}\tsprites={sprites}\tclips={clips}");
            }
            File.WriteAllText("aseprite-mcp-unity-report.txt", report.ToString());
            EditorApplication.Exit(0);
        }
    }
}
#endif
